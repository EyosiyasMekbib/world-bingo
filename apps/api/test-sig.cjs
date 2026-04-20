const crypto = require('crypto');

const secret = '1aaad248932d0140a3e6672e461089a4a798c17382739201f7ac46027fec6955';
const rawBody = `{"traceId":"409a68b9-9761-4378-ba3c-dfc9816087fa","username":"defefe","transactionId":"OneApi48ed6672-929f-41f4-a97a-b5b6e700dcab","betId":"OneApieacd2237-02c6-4c11-945b-a675951316f2","externalTransactionId":"OneApi9399317847001","amount":"11614.99882734100","currency":"ETB","token":"6b149bc8-1889-4734-a077-954d7ebd8c7f","gameCode":"SPB_aviator","roundId":"OneApi4752706831075","timestamp":1776659947769}`;

const sig = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
console.log("Expected Sig from node script:", sig);
console.log("Sig in screenshot:            ", "6f729530ebaf2a135dd0e035f495bc5fd71b608ec9a0ac0bded47172e5d56680");
