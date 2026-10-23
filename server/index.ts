import { createApp } from "./app.js";

const port = Number(process.env.PORT || process.env.API_PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT o API_PORT deve essere una porta valida.");

const { app, close } = createApp();
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Passo API in ascolto sulla porta ${port}`);
});

function shutdown() {
  close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
