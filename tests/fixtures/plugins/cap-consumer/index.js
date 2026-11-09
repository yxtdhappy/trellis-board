import { createPlugin } from "../../../../server/plugins/sdk.js";

export default createPlugin({
  name: "cap-consumer",
  version: "1.0.0",
  apiVersion: 1,
  permissions: ["capabilities:call", "http:route"],

  async onStart(ctx) {
    ctx.http.route("GET", "/echo", async () => {
      try {
        const result = await ctx.capabilities.call("demo.echo", "echo", { text: "hello" });
        return { status: 200, body: { result } };
      } catch (error) {
        return { status: 503, body: { code: error.code, message: error.message } };
      }
    });
    ctx.http.route("GET", "/forbidden", async () => {
      try {
        await ctx.capabilities.call("demo.echo", "fail");
        return { status: 200, body: { ok: true } };
      } catch (error) {
        return { status: 403, body: { code: error.code, message: error.message } };
      }
    });
  }
});
