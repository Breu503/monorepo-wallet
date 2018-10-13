export default {
  animate: `
  <style>
    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes fadeOut {
      from { opacity: 1; }
      to { opacity: 0; }
    }
    .animated {
      animation-duration: 1s;
      animation-fill-mode: both;
    }
    .fadeIn {
      animation-name: fadeIn;
    }
    .fadeOut {
      animation-name: fadeOut;
    }
  </style>
  `,
  Modal: {
    base: `
        position:relative;
        top:50%;
        display:inline-block;
        z-index:101;
        background:#fff;
        transform:translateY(-50%);
        margin:0 auto;
        border-radius: 8px;
        overflow: hidden;
        box-shadow: 0 12px 24px 0 rgba(0,0,0,0.1);
        min-width: 400px;
        max-width: 100%;
      `,
    header: `
        position: relative;
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
      `,
    headerLogo: `
      width: 100%;
      max-width: 320px;
      margin: 20px auto;
      height: 100%;
    `,
    close: {
      wrapper: `
        position: absolute;
        top: 15px;
        right: 15px;
      `,
      icon: `
        width: 25px;
        height: 25px;
        position: relative;
        top: 0;
        right: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        transform: rotate(45deg);
      `,
      line1: `
        position: absolute;
        width: 90%;
        border: 1px solid black;
      `,
      line2: `
        position: absolute;
        width: 90%;
        border: 1px solid black;
        transform: rotate(90deg);
      `
    }
  },
  QRCode: {
    base: `
      position:fixed;
      top: 0;
      width:100%;
      height:100%;
      z-index:100;
      background-color:rgba(0,0,0,0.5);
      text-align:center;
    `,
    text: `
      color: #7C828B;
      font-family: Avenir;
      font-size: 18px;
      text-align: center;
      margin: 0;
      padding: 0;
      width: 100%;
      display: flex;
      justify-content: center;
      align-items: center;
    `,
    image: `
      z-index:102;
      width: 100%;
      margin: 0;
    `
  }
}