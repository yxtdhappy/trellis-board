import { createPlugin } from "../../../../server/plugins/sdk.js";

export default createPlugin({
  name: "cap-provider",
  version: "1.0.0",
  apiVersion: 1,
  permissions: ["capabilities:provide"],

  async onStart(ctx) {
    ctx.capabilities.register("demo.echo", {
      echo: async (params, call) => ({
        text: params?.text ?? "",
        caller: call?.caller?.pluginId ?? null
      }),
      fail: async () => {
        throw ctx.error(1004, "provider failed");
      }
    });
  }
});
