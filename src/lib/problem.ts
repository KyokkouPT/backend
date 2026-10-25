import type { Problem, ProblemField } from "@kyokkou/contracts";

/** 业务错误：统一序列化成 RFC 7807 problem+json。 */
export class HttpProblem extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: ProblemField[];

  constructor(status: number, code: string, title: string, fields?: ProblemField[]) {
    super(title);
    this.name = "HttpProblem";
    this.status = status;
    this.code = code;
    if (fields && fields.length > 0) this.fields = fields;
  }

  toBody(requestId: string): Problem {
    const body: Problem = {
      type: `https://kyokkou.local/problems/${this.code}`,
      title: this.message,
      status: this.status,
      code: this.code,
      request_id: requestId,
    };
    if (this.fields) body.fields = this.fields;
    return body;
  }
}

export function badRequest(code: string, title: string, fields?: ProblemField[]): HttpProblem {
  return new HttpProblem(400, code, title, fields);
}

export function unauthorized(code = "auth_required", title = "需要登录"): HttpProblem {
  return new HttpProblem(401, code, title);
}

export function forbidden(code = "forbidden", title = "没有权限"): HttpProblem {
  return new HttpProblem(403, code, title);
}

export function notFound(code = "not_found", title = "资源不存在"): HttpProblem {
  return new HttpProblem(404, code, title);
}

export function conflict(code: string, title: string): HttpProblem {
  return new HttpProblem(409, code, title);
}
