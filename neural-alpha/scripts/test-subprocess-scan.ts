import { scanWalletViaCliSubprocess } from "../src/integrations/bscscan.js";

const addr = "0x6bcF0027f1d151d8CBc8d6Ff07915b0BA9616b1E";
const r = await scanWalletViaCliSubprocess(addr);
console.log("result", r);
