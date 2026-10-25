import { z } from "zod";
import { HttpProblem } from "./problem.js";

/** 用 zod 校验请求体；失败时抛 400 problem+json，带上字段错误。 */
export function parseOrThrow<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new HttpProblem(
      400,
      "invalid_body",
      "请求参数不合法",
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return result.data;
}
