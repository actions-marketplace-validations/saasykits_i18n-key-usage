import { writeFileSync } from "node:fs";
import { z } from "zod";
import { configSchema } from "../src/config";

const schema = z.toJSONSchema(configSchema, { io: "input" });
writeFileSync(
  new URL("../schema.json", import.meta.url),
  `${JSON.stringify({ ...schema, title: "i18n-key-usage config" }, null, 2)}\n`,
);
