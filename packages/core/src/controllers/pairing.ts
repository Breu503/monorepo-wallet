import { generateChildLogger, getLoggerContext } from "@walletconnect/logger";
import {
  ICore,
  PairingTypes,
  IPairing,
  IPairingPrivate,
  IStore,
  RelayerTypes,
  PairingJsonRpcTypes,
} from "@walletconnect/types";
import {
  getInternalError,
  parseUri,
  calcExpiry,
  generateRandomBytes32,
  formatUri,
  getSdkError,
  engineEvent,
  createDelayedPromise,
  isValidParams,
  isValidUrl,
} from "@walletconnect/utils";
import {
  formatJsonRpcRequest,
  formatJsonRpcResult,
  formatJsonRpcError,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isJsonRpcResult,
  isJsonRpcError,
} from "@walletconnect/jsonrpc-utils";
import { FIVE_MINUTES, THIRTY_DAYS } from "@walletconnect/time";
import EventEmitter from "events";
import { Logger } from "pino";
import {
  PAIRING_CONTEXT,
  PAIRING_STORAGE_VERSION,
  CORE_STORAGE_PREFIX,
  RELAYER_DEFAULT_PROTOCOL,
  PAIRING_RPC_OPTS,
  RELAYER_EVENTS,
} from "../constants";
import { Store } from "../controllers/store";
import { JsonRpcHistory } from "../controllers/history";

export class Pairing implements IPairing {
  public name = PAIRING_CONTEXT;
  public version = PAIRING_STORAGE_VERSION;

  public events = new EventEmitter();
  public pairings: IStore<string, PairingTypes.Struct>;
  public history: IPairing["history"];

  private initialized = false;
  private storagePrefix = CORE_STORAGE_PREFIX;

  constructor(public core: ICore, public logger: Logger) {
    this.core = core;
    this.logger = generateChildLogger(logger, this.name);
    this.pairings = new Store(this.core, this.logger, this.name, this.storagePrefix);
    this.history = new JsonRpcHistory(this.core, this.logger);
  }

  public init: IPairing["init"] = async () => {
    if (!this.initialized) {
      this.logger.trace(`Initialized`);
      await this.pairings.init();
      await this.history.init();
      this.registerRelayerEvents();
      this.initialized = true;
    }
  };

  get context() {
    return getLoggerContext(this.logger);
  }

  public create: IPairing["create"] = async () => {
    const symKey = generateRandomBytes32();
    const topic = await this.core.crypto.setSymKey(symKey);
    const expiry = calcExpiry(FIVE_MINUTES);
    const relay = { protocol: RELAYER_DEFAULT_PROTOCOL };
    const pairing = { topic, expiry, relay, active: false };
    const uri = formatUri({
      protocol: this.core.protocol,
      version: this.core.version,
      topic,
      symKey,
      relay,
    });
    await this.pairings.set(topic, pairing);
    await this.core.relayer.subscribe(topic);

    // FIXME: We need to move expirer to core for this to work.
    // this.core.expirer.set(topic, expiry);

    return { topic, uri };
  };

  public pair: IPairing["pair"] = async (params) => {
    this.isInitialized();
    this.isValidPair(params);
    const { topic, symKey, relay } = parseUri(params.uri);
    const expiry = calcExpiry(FIVE_MINUTES);
    const pairing = { topic, relay, expiry, active: false };
    await this.pairings.set(topic, pairing);
    await this.core.crypto.setSymKey(symKey, topic);
    await this.core.relayer.subscribe(topic, { relay });

    // FIXME: We need to move expirer to core for this to work.
    // this.core.expirer.set(topic, expiry);

    return pairing;
  };

  public activate: IPairing["activate"] = async ({ topic }) => {
    const expiry = calcExpiry(THIRTY_DAYS);
    await this.pairings.update(topic, { active: true, expiry });

    // FIXME: We need to move expirer to core for this to work.
    // this.core.expirer.set(topic, expiry);
  };

  public ping: IPairing["ping"] = async (params) => {
    this.isInitialized();
    // TODO: adapt validation logic from SignClient.Engine
    // await this.isValidPing(params);
    const { topic } = params;
    if (this.pairings.keys.includes(topic)) {
      const id = await this.sendRequest(topic, "wc_pairingPing", {});
      const { done, resolve, reject } = createDelayedPromise<void>();
      this.events.once(engineEvent("pairing_ping", id), ({ error }) => {
        if (error) reject(error);
        else resolve();
      });
      await done();
    }
  };

  public updateExpiry: IPairing["updateExpiry"] = async ({ topic, expiry }) => {
    await this.pairings.update(topic, { expiry });
  };

  public updateMetadata: IPairing["updateMetadata"] = async ({ topic, metadata }) => {
    await this.pairings.update(topic, { peerMetadata: metadata });
  };

  public getPairings: IPairing["getPairings"] = () => {
    return this.pairings.values;
  };

  public disconnect: IPairing["disconnect"] = async (params) => {
    this.isInitialized();
    // TODO: move validation logic from SignClient.Engine to this class.
    // await this.isValidDisconnect(params);
    const { topic } = params;
    if (this.pairings.keys.includes(topic)) {
      await this.sendRequest(topic, "wc_pairingDelete", getSdkError("USER_DISCONNECTED"));
      await this.deletePairing(topic);
    }
  };

  // ---------- Private Helpers ----------------------------------------------- //

  private sendRequest: IPairingPrivate["sendRequest"] = async (topic, method, params) => {
    const payload = formatJsonRpcRequest(method, params);
    const message = await this.core.crypto.encode(topic, payload);
    const opts = PAIRING_RPC_OPTS[method].req;
    this.history.set(topic, payload);
    await this.core.relayer.publish(topic, message, opts);

    return payload.id;
  };

  private sendResult: IPairingPrivate["sendResult"] = async (id, topic, result) => {
    const payload = formatJsonRpcResult(id, result);
    const message = await this.core.crypto.encode(topic, payload);
    const record = await this.history.get(topic, id);
    const opts = PAIRING_RPC_OPTS[record.request.method].res;
    await this.core.relayer.publish(topic, message, opts);
    await this.history.resolve(payload);
  };

  private sendError: IPairingPrivate["sendError"] = async (id, topic, error) => {
    const payload = formatJsonRpcError(id, error);
    const message = await this.core.crypto.encode(topic, payload);
    const record = await this.history.get(topic, id);
    const opts = PAIRING_RPC_OPTS[record.request.method].res;
    await this.core.relayer.publish(topic, message, opts);
    await this.history.resolve(payload);
  };

  private deletePairing: IPairingPrivate["deletePairing"] = async (topic, _expirerHasDeleted) => {
    // Await the unsubscribe first to avoid deleting the symKey too early below.
    await this.core.relayer.unsubscribe(topic);
    await Promise.all([
      this.pairings.delete(topic, getSdkError("USER_DISCONNECTED")),
      this.core.crypto.deleteSymKey(topic),
      // FIXME: We need to move expirer to core for this to work.
      // expirerHasDeleted ? Promise.resolve() : this.core.expirer.del(topic),
    ]);
  };

  private isInitialized() {
    if (!this.initialized) {
      const { message } = getInternalError("NOT_INITIALIZED", this.name);
      throw new Error(message);
    }
  }

  // ---------- Relay Events Router ----------------------------------- //

  private registerRelayerEvents() {
    this.core.relayer.on(RELAYER_EVENTS.message, async (event: RelayerTypes.MessageEvent) => {
      const { topic, message } = event;
      const payload = await this.core.crypto.decode(topic, message);
      if (isJsonRpcRequest(payload)) {
        this.history.set(topic, payload);
        this.onRelayEventRequest({ topic, payload });
      } else if (isJsonRpcResponse(payload)) {
        await this.history.resolve(payload);
        this.onRelayEventResponse({ topic, payload });
      }
    });
  }

  private onRelayEventRequest = (event: any) => {
    const { topic, payload } = event;
    const reqMethod = payload.method as PairingJsonRpcTypes.WcMethod;

    switch (reqMethod) {
      case "wc_pairingPing":
        return this.onPairingPingRequest(topic, payload);
      case "wc_pairingDelete":
        return this.onPairingDeleteRequest(topic, payload);
      default:
        return this.logger.info(`Unsupported request method ${reqMethod}`);
    }
  };

  private onRelayEventResponse = async (event: any) => {
    const { topic, payload } = event;
    const record = await this.history.get(topic, payload.id);
    const resMethod = record.request.method as PairingJsonRpcTypes.WcMethod;

    switch (resMethod) {
      case "wc_pairingPing":
        return this.onPairingPingResponse(topic, payload);
      default:
        return this.logger.info(`Unsupported response method ${resMethod}`);
    }
  };

  private onPairingPingRequest = async (topic: string, payload: any) => {
    const { id } = payload;
    try {
      // TODO: adapt validation logic from SignClient.Engine.
      // this.isValidPing({ topic });
      await this.sendResult<"wc_pairingPing">(id, topic, true);
      this.events.emit("pairing_ping", { id, topic });
    } catch (err: any) {
      await this.sendError(id, topic, err);
      this.logger.error(err);
    }
  };

  private onPairingPingResponse = (_topic: string, payload: any) => {
    const { id } = payload;
    if (isJsonRpcResult(payload)) {
      this.events.emit(engineEvent("pairing_ping", id), {});
    } else if (isJsonRpcError(payload)) {
      this.events.emit(engineEvent("pairing_ping", id), { error: payload.error });
    }
  };

  private onPairingDeleteRequest = async (topic: string, payload: any) => {
    const { id } = payload;
    try {
      // TODO: adapt validation logic from SignClient.Engine.
      // this.isValidDisconnect({ topic, reason: payload.params });
      // RPC request needs to happen before deletion as it utilises pairing encryption
      await this.sendResult<"wc_pairingDelete">(id, topic, true);
      await this.deletePairing(topic);
      this.events.emit("pairing_delete", { id, topic });
    } catch (err: any) {
      await this.sendError(id, topic, err);
      this.logger.error(err);
    }
  };

  // ---------- Validation Helpers ----------------------------------- //

  private isValidPair = (params: { uri: string }) => {
    if (!isValidParams(params)) {
      const { message } = getInternalError("MISSING_OR_INVALID", `pair() params: ${params}`);
      throw new Error(message);
    }
    if (!isValidUrl(params.uri)) {
      const { message } = getInternalError("MISSING_OR_INVALID", `pair() uri: ${params.uri}`);
      throw new Error(message);
    }
  };
}