import app from "./app.ts";

const PORT = Number(process.env["PORT"] ?? 8000);

app.listen(PORT, () => {
  console.log(`server listening on port ${PORT}`);
});
