import { proxyAdmin } from "../_adminProxy.js";
export default (req, res) => proxyAdmin(req, res, "demo-pay");
