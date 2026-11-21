// 商業規則錯誤：帶一個穩定的代號，讓代理可以依代號判斷下一步。
// 獨立成一個模組，讓 chain.js 也能丟出（chain.js 若 import workorder.js，兩個模組會互相匯入）；workorder.js 照舊匯出同一個類別。
export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
