import { expect, layer } from "@effect/vitest";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { scenarios } from "../test-plan.ts";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body } from "../support/api.ts";
import { Actors } from "../support/actors.ts";
import { App } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";

/**
 * Every app evaluation builds each imported schema again, so building one must stay a single
 * pass over its document. `shared` reaches its leaf through 2^30 paths: a check that revisits
 * shared parts cannot finish within the scenario deadline. `nested` is 20,000 levels deep: a
 * recursive check overflows the stack and the evaluation fails. Neither schema is parsed, so
 * only construction is exercised; `source.route` shows a shared definition still validates.
 */
const source = `
import { defineApp, dynamicRouter, jsonSchema, query, router, object, array, record } from "apps";
const address = { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false };
const route = { type: "object", properties: { home: address, work: address }, required: ["home", "work"], additionalProperties: false };
let shared = { type: "string" };
for (let level = 0; level < 30; level++) shared = { anyOf: [shared, shared] };
let nested = { type: "string" };
for (let level = 0; level < 20000; level++) nested = { not: nested };
const color = jsonSchema({ type: "string", enum: ["red", "blue"] });
const shapes = object({
  list: array(color),
  [String.fromCharCode(0xd800)]: color,
  values: record(color),
  optional: color.optional(),
  defaulted: color.default("red"),
  choice: jsonSchema({ anyOf: [{ type: "string", enum: ["red", "blue"] }, { type: "number" }] }),
  first: jsonSchema({ $defs: { Color: { type: "string", enum: ["red"] } }, $ref: "#/$defs/Color" }),
  second: jsonSchema({ $defs: { Color: { type: "string", enum: ["blue"] } }, $ref: "#/$defs/Color" }),
  identified: jsonSchema({ $schema: "https://json-schema.org/draft/2020-12/schema", $id: "https://fixture.invalid/red", $defs: { Color: { type: "string", enum: ["red"] } }, $ref: "#/$defs/Color" }),
  legacy: jsonSchema({ definitions: { Color: { type: "string", enum: ["red", "blue"] } }, $ref: "#/definitions/Color" }),
  "a/~#": array(jsonSchema({ type: "object", properties: { child: { $ref: "#" } }, additionalProperties: false })),
});
export default defineApp({}, {
  tools: router({
    dialects: query({ input: object({}) }, async () => {
      const legacy = jsonSchema({ $schema: "http://json-schema.org/draft-07/schema#", type: "string" });
      return { root: legacy.optional().default("red").parse("blue"), rejected: [
        () => object({ value: legacy }), () => array(legacy), () => record(legacy),
        () => object({ value: legacy.optional().default("red") }),
      ].map(declare => { try { declare(); return false; } catch (error) { return error instanceof TypeError && error.message.includes("Nested jsonSchema() documents must use draft 2020-12"); } }) };
    }),
    shapes: query({ input: shapes, output: shapes }, async (_, input) => input),
    colors: query({ input: array(color.optional().default("red")), output: record(color) }, async (_, input) => ({ color: input[0] })),
    invalidOutput: query({ input: object({}), output: object({ nested: color }) }, async () => ({ nested: "green" })),
    source: dynamicRouter({
      list: async () => [{ name: "route", description: "Echo a route", inputSchema: route, readOnly: true }],
      resolve: async (name) => {
        jsonSchema({ type: "object", properties: { value: shared } });
        jsonSchema(nested);
        return name === "route" ? query({ input: jsonSchema(route) }, async (_, input) => JSON.stringify(input)) : undefined;
      },
    }),
  }),
});
`;

layer(HostedLive, { excludeTestServices: true })("Imported JSON Schemas", (it) => {
  it.effect(scenarios.importedJsonSchemaDocuments.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Imported schemas ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: source }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const path = `${prefix}/${(yield* body(App, deployed)).id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );
        const call = (input: unknown) =>
          api.request(actors.owner, "POST", `${path}/tools/call`, {
            tool: "source.route",
            input,
          });
        const input = { home: { city: "Springfield" }, work: { city: "Shelbyville" } };
        // Two calls: each evaluates the app and builds both schemas again.
        for (const _ of [1, 2]) {
          const result = yield* call(input);
          expect(result.status, JSON.stringify(result.body)).toBe(200);
          expect(JSON.parse(yield* body(Schema.String, result))).toEqual(input);
        }
        const invalid = yield* call({ home: { city: "Springfield" }, work: {} });
        expect(invalid.status, JSON.stringify(invalid.body)).not.toBe(200);

        const advertised = yield* body(
          Schema.Struct({ inputSchema: Schema.Json, outputSchema: Schema.Json }),
          yield* api.request(actors.owner, "GET", `${path}/tools/shapes`),
        );
        const color = { type: "string", enum: ["red", "blue"] };
        for (const document of [advertised.inputSchema, advertised.outputSchema]) {
          expect(document).toMatchObject({
            $defs: { Color: { type: "string", enum: ["red"] } },
            properties: {
              list: { type: "array", items: color },
              [String.fromCharCode(0xd800)]: color,
              values: { type: "object", additionalProperties: color },
              optional: color,
              defaulted: { ...color, default: "red" },
              choice: { anyOf: [color, { type: "number" }] },
              first: { $ref: "#/$defs/Color" },
              second: {
                $ref: "#/properties/second/$defs/Color",
                $defs: { Color: { type: "string", enum: ["blue"] } },
              },
              identified: { $ref: "#/properties/identified/$defs/Color" },
              legacy: { $ref: "#/properties/legacy/definitions/Color" },
            },
          });
          // Every local reference must resolve in the advertised parent, including conflicting
          // definition names, legacy definitions and an imported root nested under an escaped key.
          const visit = (value: Schema.Json): void => {
            if (value === null || typeof value !== "object") return;
            if (Array.isArray(value)) return value.forEach(visit);
            const reference: unknown = Reflect.get(value, "$ref");
            if (typeof reference === "string") {
              expect(reference.startsWith("#/"), reference).toBe(true);
              let target: Schema.Json | undefined = document;
              for (const segment of reference.slice(2).split("/")) {
                const key = decodeURIComponent(segment).replaceAll("~1", "/").replaceAll("~0", "~");
                target =
                  target !== null && typeof target === "object"
                    ? Reflect.get(target, key)
                    : undefined;
              }
              expect(target, reference).toBeDefined();
            }
            if (value !== document) {
              expect(value).not.toHaveProperty("$id");
              expect(value).not.toHaveProperty("$schema");
            }
            Object.values(value).forEach(visit);
          };
          visit(document);
        }
        const shapesInput = {
          list: ["blue"],
          [String.fromCharCode(0xd800)]: "red",
          values: { primary: "red" },
          choice: 1,
          first: "red",
          second: "blue",
          identified: "red",
          legacy: "red",
          "a/~#": [{ child: {} }],
        };
        const shapesCall = (input: unknown) =>
          api.request(actors.owner, "POST", `${path}/tools/call`, { tool: "shapes", input });
        const valid = yield* shapesCall(shapesInput);
        expect(valid.status, JSON.stringify(valid.body)).toBe(200);
        expect(valid.body).toEqual({ ...shapesInput, defaulted: "red" });
        for (const patch of [
          { list: ["green"] },
          { values: { primary: "green" } },
          { optional: "green" },
          { defaulted: "green" },
          { choice: false },
          { first: "blue" },
          { second: "red" },
          { identified: "blue" },
          { legacy: "green" },
          { "a/~#": [{ child: { unexpected: true } }] },
        ]) {
          const rejected = yield* shapesCall({ ...shapesInput, ...patch });
          expect(rejected.status, JSON.stringify(patch)).toBe(422);
        }
        const colors = yield* body(
          Schema.Struct({ inputSchema: Schema.Json, outputSchema: Schema.Json }),
          yield* api.request(actors.owner, "GET", `${path}/tools/colors`),
        );
        expect(colors.inputSchema).toMatchObject({
          type: "array",
          items: { ...color, default: "red" },
        });
        expect(colors.outputSchema).toMatchObject({ type: "object", additionalProperties: color });
        const badOutput = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "invalidOutput",
          input: {},
        });
        expect(badOutput.status).not.toBe(200);
        expect(badOutput.body).toMatchObject({ _tag: "ToolCallFailed" });
        const dialects = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "dialects",
          input: {},
        });
        expect(dialects.status, JSON.stringify(dialects.body)).toBe(200);
        expect(dialects.body).toEqual({ root: "blue", rejected: [true, true, true, true] });
      }),
    ),
  );
});
