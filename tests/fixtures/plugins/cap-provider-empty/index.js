import { createPlugin } from "../../../../server/plugins/sdk.js";

export default createPlugin({
  name: "cap-provider-empty",
  version: "1.0.0",
  apiVersion: 1,
  permissions: ["capabilities:provide"]
});
