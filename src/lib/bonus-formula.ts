/**
 * Bonus Formula DSL（docs/22）。
 *
 * 设计目标：白名单数值表达式，无 I/O、无对象访问、无 eval。
 * 程序由若干 `变量 = 表达式` 组成，最后用 `result` 表示每小时产出。
 */

export type FormulaTorrent = {
  id: number;
  sizeBytes: number;
  ageWeeks: number;
  ageDays: number;
  seeders: number;
  zeroBonus: boolean;
  promo?: string;
};

export type FormulaUserMetrics = {
  seeders: number;
  totalGb: number;
  totalBytes: number;
  avgSizeGb: number;
  uploaded: number;
  downloaded: number;
  ratio: number;
  ageDays: number;
  bonus: number;
  isDonor: boolean;
  hour: number;
  dayOfWeek: number;
  userId: number;
};

export type FormulaContext = {
  user: FormulaUserMetrics;
  torrents: FormulaTorrent[];
};

export type FormulaTorrentTerm = {
  id: number;
  size_gb: number;
  age_weeks: number;
  seeders: number;
  weight: number;
  term: number;
};

export type FormulaEvaluation = {
  result: number;
  variables: Record<string, number>;
  torrents: FormulaTorrentTerm[];
  warnings: string[];
};

export class FormulaError extends Error {
  line: number;
  column: number;

  constructor(message: string, line = 1, column = 1) {
    super(message);
    this.name = "FormulaError";
    this.line = line;
    this.column = column;
  }
}

type TokenKind = "number" | "ident" | "op" | "lparen" | "rparen" | "comma" | "sep" | "eof";

type Token = {
  kind: TokenKind;
  text: string;
  value?: number;
  line: number;
  column: number;
};

type Expr =
  | { kind: "number"; value: number; line: number; column: number }
  | { kind: "var"; name: string; line: number; column: number }
  | { kind: "unary"; op: string; expr: Expr; line: number; column: number }
  | { kind: "binary"; op: string; left: Expr; right: Expr; line: number; column: number }
  | { kind: "call"; name: string; args: Expr[]; line: number; column: number };

type Statement = { name: string; expr: Expr; line: number; column: number };

export type FormulaProgram = { statements: Statement[]; source: string };

const USER_METRICS = new Set([
  "seeders",
  "total_gb",
  "total_bytes",
  "avg_size_gb",
  "uploaded",
  "downloaded",
  "ratio",
  "age_days",
  "bonus",
  "is_donor",
  "hour",
  "day_of_week",
  "user_id",
]);

const TORRENT_METRICS = new Set([
  "t.age_weeks",
  "t.age_days",
  "t.size_gb",
  "t.size_bytes",
  "t.seeders",
  "t.weight",
  "t.is_zero_bonus",
  "t.promo",
  "t.id",
]);

const CONSTANTS = new Set(["pi", "e"]);

const AGGREGATES = new Set(["sum", "avg", "max_t", "min_t", "count"]);

const FUNCTIONS: Record<string, { min: number; max: number }> = {
  min: { min: 2, max: 2 },
  max: { min: 2, max: 2 },
  abs: { min: 1, max: 1 },
  sqrt: { min: 1, max: 1 },
  pow: { min: 2, max: 2 },
  exp: { min: 1, max: 1 },
  log10: { min: 1, max: 1 },
  atan: { min: 1, max: 1 },
  if: { min: 3, max: 3 },
  round: { min: 1, max: 2 },
  floor: { min: 1, max: 2 },
  ceil: { min: 1, max: 2 },
  trunc: { min: 1, max: 2 },
};

const RESERVED = new Set([
  ...USER_METRICS,
  ...CONSTANTS,
  ...AGGREGATES,
  ...Object.keys(FUNCTIONS),
  "and",
  "or",
  "not",
]);

function fail(message: string, token: Token): never {
  throw new FormulaError(message, token.line, token.column);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let column = 1;
  let depth = 0;

  const push = (kind: TokenKind, text: string, tokenLine: number, tokenColumn: number, value?: number) => {
    tokens.push({ kind, text, value, line: tokenLine, column: tokenColumn });
  };

  while (index < source.length) {
    const char = source[index] ?? "";
    const startLine = line;
    const startColumn = column;

    if (char === "\n") {
      index += 1;
      line += 1;
      column = 1;
      if (depth === 0) push("sep", "\n", startLine, startColumn);
      continue;
    }
    if (char === "\r") {
      index += 1;
      continue;
    }
    if (char === " " || char === "\t") {
      index += 1;
      column += 1;
      continue;
    }
    if (char === ";") {
      index += 1;
      column += 1;
      push("sep", ";", startLine, startColumn);
      continue;
    }
    if (char === "(") {
      depth += 1;
      index += 1;
      column += 1;
      push("lparen", "(", startLine, startColumn);
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
      column += 1;
      push("rparen", ")", startLine, startColumn);
      continue;
    }
    if (char === ",") {
      index += 1;
      column += 1;
      push("comma", ",", startLine, startColumn);
      continue;
    }

    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(source[index + 1] ?? ""))) {
      let text = "";
      let seenDot = false;
      while (index < source.length) {
        const current = source[index] ?? "";
        if (/[0-9]/.test(current)) {
          text += current;
          index += 1;
          column += 1;
        } else if (current === "." && !seenDot) {
          seenDot = true;
          text += current;
          index += 1;
          column += 1;
        } else {
          break;
        }
      }
      const value = Number(text);
      if (!Number.isFinite(value)) throw new FormulaError(`无效数字：${text}`, startLine, startColumn);
      push("number", text, startLine, startColumn, value);
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      let text = "";
      while (index < source.length) {
        const current = source[index] ?? "";
        if (/[A-Za-z0-9_.]/.test(current)) {
          text += current;
          index += 1;
          column += 1;
        } else {
          break;
        }
      }
      push("ident", text.toLowerCase(), startLine, startColumn);
      continue;
    }

    const two = source.slice(index, index + 2);
    if ([">=", "<=", "==", "!=", "&&", "||"].includes(two)) {
      index += 2;
      column += 2;
      const normalized = two === "&&" ? "and" : two === "||" ? "or" : two;
      push("op", normalized, startLine, startColumn);
      continue;
    }
    if ([">", "<", "+", "-", "*", "/", "%", "^", "="].includes(char)) {
      index += 1;
      column += 1;
      push("op", char, startLine, startColumn);
      continue;
    }

    throw new FormulaError(`无法识别的字符：${char}`, startLine, startColumn);
  }

  tokens.push({ kind: "eof", text: "", line, column });
  return tokens;
}

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly source: string,
  ) {}

  parse(): FormulaProgram {
    const statements: Statement[] = [];
    this.skipSeparators();
    while (!this.check("eof")) {
      const start = this.current();
      if (start.kind !== "ident") fail("语句必须以变量名开头", start);
      const name = start.text;
      this.advance();
      this.expect("op", "=");
      const expr = this.parseExpression();
      statements.push({ name, expr, line: start.line, column: start.column });
      this.skipSeparators();
      if (!this.check("eof") && !this.previousIsSeparator()) {
        fail("语句之间需要换行或分号", this.current());
      }
      this.skipSeparators();
    }
    if (statements.length === 0) {
      throw new FormulaError("公式不能为空", 1, 1);
    }
    validateProgram(statements);
    return { statements, source: this.source };
  }

  private previousIsSeparator(): boolean {
    return true; // parse 循环内已通过 skipSeparators 消费分隔符
  }

  private parseExpression(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.matchOp("or")) {
      const token = this.previous();
      const right = this.parseAnd();
      left = { kind: "binary", op: "or", left, right, line: token.line, column: token.column };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseComparison();
    while (this.matchOp("and")) {
      const token = this.previous();
      const right = this.parseComparison();
      left = { kind: "binary", op: "and", left, right, line: token.line, column: token.column };
    }
    return left;
  }

  private parseComparison(): Expr {
    const left = this.parseAdd();
    const token = this.current();
    if (token.kind === "op" && [">", ">=", "<", "<=", "==", "!="].includes(token.text)) {
      this.advance();
      const right = this.parseAdd();
      return { kind: "binary", op: token.text, left, right, line: token.line, column: token.column };
    }
    return left;
  }

  private parseAdd(): Expr {
    let left = this.parseMul();
    while (this.check("op") && (this.current().text === "+" || this.current().text === "-")) {
      const token = this.advance();
      const right = this.parseMul();
      left = { kind: "binary", op: token.text, left, right, line: token.line, column: token.column };
    }
    return left;
  }

  private parseMul(): Expr {
    let left = this.parsePow();
    while (this.check("op") && ["*", "/", "%"].includes(this.current().text)) {
      const token = this.advance();
      const right = this.parsePow();
      left = { kind: "binary", op: token.text, left, right, line: token.line, column: token.column };
    }
    return left;
  }

  private parsePow(): Expr {
    const left = this.parseUnary();
    if (this.matchOp("^")) {
      const token = this.previous();
      const right = this.parsePow();
      return { kind: "binary", op: "^", left, right, line: token.line, column: token.column };
    }
    return left;
  }

  private parseUnary(): Expr {
    const token = this.current();
    if (token.kind === "op" && (token.text === "-" || token.text === "+")) {
      this.advance();
      return {
        kind: "unary",
        op: token.text,
        expr: this.parseUnary(),
        line: token.line,
        column: token.column,
      };
    }
    if (token.kind === "ident" && token.text === "not") {
      this.advance();
      return {
        kind: "unary",
        op: "not",
        expr: this.parseUnary(),
        line: token.line,
        column: token.column,
      };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const token = this.current();
    if (token.kind === "number") {
      this.advance();
      return { kind: "number", value: token.value ?? 0, line: token.line, column: token.column };
    }
    if (token.kind === "lparen") {
      this.advance();
      const expr = this.parseExpression();
      this.expect("rparen", ")");
      return expr;
    }
    if (token.kind === "ident") {
      this.advance();
      if (this.check("lparen")) {
        this.advance();
        const args: Expr[] = [];
        if (!this.check("rparen")) {
          for (;;) {
            args.push(this.parseExpression());
            if (this.match("comma")) continue;
            break;
          }
        }
        this.expect("rparen", ")");
        return { kind: "call", name: token.text, args, line: token.line, column: token.column };
      }
      return { kind: "var", name: token.text, line: token.line, column: token.column };
    }
    fail("缺少表达式", token);
  }

  private skipSeparators(): void {
    while (this.check("sep")) this.advance();
  }

  private check(kind: TokenKind): boolean {
    return this.current().kind === kind;
  }

  private match(kind: TokenKind): boolean {
    if (!this.check(kind)) return false;
    this.advance();
    return true;
  }

  private matchOp(op: string): boolean {
    if (this.check("op") && this.current().text === op) {
      this.advance();
      return true;
    }
    return false;
  }

  private expect(kind: TokenKind, text?: string): Token {
    const token = this.current();
    if (token.kind !== kind || (text !== undefined && token.text !== text)) {
      fail(`期望 ${text ?? kind}`, token);
    }
    this.advance();
    return token;
  }

  private current(): Token {
    return this.tokens[this.index] ?? { kind: "eof", text: "", line: 1, column: 1 };
  }

  private previous(): Token {
    return this.tokens[Math.max(0, this.index - 1)] ?? this.current();
  }

  private advance(): Token {
    const token = this.current();
    this.index += 1;
    return token;
  }
}

function isAggregate(name: string): boolean {
  return AGGREGATES.has(name);
}

function validateExpr(expr: Expr, defined: Set<string>, inAggregate: boolean): void {
  switch (expr.kind) {
    case "number":
      return;
    case "var": {
      if (expr.name.startsWith("t.")) {
        if (!inAggregate) {
          throw new FormulaError(`逐种子变量只能在 sum/avg 等聚合内使用：${expr.name}`, expr.line, expr.column);
        }
        if (!TORRENT_METRICS.has(expr.name)) {
          throw new FormulaError(`未知逐种子变量：${expr.name}`, expr.line, expr.column);
        }
        return;
      }
      if (CONSTANTS.has(expr.name)) return;
      if (USER_METRICS.has(expr.name)) return;
      if (!defined.has(expr.name)) {
        throw new FormulaError(`未定义变量：${expr.name}`, expr.line, expr.column);
      }
      return;
    }
    case "unary":
      validateExpr(expr.expr, defined, inAggregate);
      return;
    case "binary":
      validateExpr(expr.left, defined, inAggregate);
      validateExpr(expr.right, defined, inAggregate);
      return;
    case "call": {
      if (isAggregate(expr.name)) {
        if (inAggregate) throw new FormulaError("聚合不能嵌套", expr.line, expr.column);
        if (expr.args.length !== 1) throw new FormulaError(`${expr.name} 需要 1 个参数`, expr.line, expr.column);
        validateExpr(expr.args[0] as Expr, defined, true);
        return;
      }
      const arity = FUNCTIONS[expr.name];
      if (!arity) throw new FormulaError(`未知函数：${expr.name}`, expr.line, expr.column);
      if (expr.args.length < arity.min || expr.args.length > arity.max) {
        throw new FormulaError(`${expr.name} 参数个数不正确`, expr.line, expr.column);
      }
      for (const arg of expr.args) validateExpr(arg, defined, inAggregate);
      return;
    }
  }
}

function validateProgram(statements: Statement[]): void {
  const defined = new Set<string>();
  for (const statement of statements) {
    if (RESERVED.has(statement.name) || statement.name.includes(".")) {
      throw new FormulaError(`变量名不能使用保留字：${statement.name}`, statement.line, statement.column);
    }
    validateExpr(statement.expr, defined, false);
    defined.add(statement.name);
  }
}

const cache = new Map<string, FormulaProgram>();

export function compileFormula(source: string): FormulaProgram {
  const cached = cache.get(source);
  if (cached) return cached;
  if (source.length > 2000) throw new FormulaError("公式不能超过 2000 个字符", 1, 1);
  const program = new Parser(tokenize(source), source).parse();
  cache.set(source, program);
  if (cache.size > 8) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  return program;
}

export function clearFormulaCache(): void {
  cache.clear();
}

function numeric(value: number, expr: Expr): number {
  if (!Number.isFinite(value)) {
    throw new FormulaError("计算结果不是有限数", expr.line, expr.column);
  }
  return value;
}

function roundHalfAway(value: number, digits: number): number {
  const factor = 10 ** Math.max(-12, Math.min(12, digits));
  return (Math.sign(value) * Math.floor(Math.abs(value) * factor + 0.5)) / factor;
}

function truncDigits(value: number, digits: number): number {
  const factor = 10 ** Math.max(-12, Math.min(12, digits));
  return (Math.sign(value) * Math.floor(Math.abs(value) * factor)) / factor;
}

function readDigits(args: Expr[], index: number): number {
  if (!args[index]) return 0;
  const value = evaluateExpr(args[index] as Expr, emptyScope());
  if (!Number.isInteger(value)) throw new Error("取整位数必须是整数");
  return value;
}


function emptyScope(): EvalScope {
  return {
    variables: new Map(),
    user: {
      seeders: 0,
      totalGb: 0,
      totalBytes: 0,
      avgSizeGb: 0,
      uploaded: 0,
      downloaded: 0,
      ratio: 0,
      ageDays: 0,
      bonus: 0,
      isDonor: false,
      hour: 0,
      dayOfWeek: 0,
      userId: 0,
    },
  };
}

type EvalScope = {
  variables: Map<string, number>;
  user: FormulaUserMetrics;
  torrent?: FormulaTorrent;
};

function evalTorrent(metric: string, torrent: FormulaTorrent): number {
  switch (metric) {
    case "t.age_weeks":
      return torrent.ageWeeks;
    case "t.age_days":
      return torrent.ageDays;
    case "t.size_gb":
      return torrent.sizeBytes / 1024 ** 3;
    case "t.size_bytes":
      return torrent.sizeBytes;
    case "t.seeders":
      return torrent.seeders;
    case "t.weight":
      return torrent.zeroBonus ? 0.2 : 1;
    case "t.is_zero_bonus":
      return torrent.zeroBonus ? 1 : 0;
    case "t.promo":
      return torrent.promo === "none" || torrent.promo === undefined ? 0 : 1;
    case "t.id":
      return torrent.id;
    default:
      return 0;
  }
}

function evalUser(metric: string, user: FormulaUserMetrics): number {
  switch (metric) {
    case "seeders":
      return user.seeders;
    case "total_gb":
      return user.totalGb;
    case "total_bytes":
      return user.totalBytes;
    case "avg_size_gb":
      return user.avgSizeGb;
    case "uploaded":
      return user.uploaded;
    case "downloaded":
      return user.downloaded;
    case "ratio":
      return user.ratio;
    case "age_days":
      return user.ageDays;
    case "bonus":
      return user.bonus;
    case "is_donor":
      return user.isDonor ? 1 : 0;
    case "hour":
      return user.hour;
    case "day_of_week":
      return user.dayOfWeek;
    case "user_id":
      return user.userId;
    default:
      return 0;
  }
}

function evaluateExpr(expr: Expr, scope: EvalScope): number {
  switch (expr.kind) {
    case "number":
      return expr.value;
    case "var": {
      if (expr.name === "pi") return Math.PI;
      if (expr.name === "e") return Math.E;
      if (expr.name.startsWith("t.")) {
        if (!scope.torrent) throw new FormulaError("逐种子变量不在聚合作用域内", expr.line, expr.column);
        return evalTorrent(expr.name, scope.torrent);
      }
      if (USER_METRICS.has(expr.name)) return evalUser(expr.name, scope.user);
      const value = scope.variables.get(expr.name);
      if (value === undefined) throw new FormulaError(`未定义变量：${expr.name}`, expr.line, expr.column);
      return value;
    }
    case "unary": {
      const value = evaluateExpr(expr.expr, scope);
      if (expr.op === "-") return -value;
      if (expr.op === "+") return value;
      return value === 0 ? 1 : 0;
    }
    case "binary": {
      if (expr.op === "and") {
        return evaluateExpr(expr.left, scope) !== 0 && evaluateExpr(expr.right, scope) !== 0 ? 1 : 0;
      }
      if (expr.op === "or") {
        return evaluateExpr(expr.left, scope) !== 0 || evaluateExpr(expr.right, scope) !== 0 ? 1 : 0;
      }
      const left = evaluateExpr(expr.left, scope);
      const right = evaluateExpr(expr.right, scope);
      switch (expr.op) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          return right === 0 ? 0 : left / right;
        case "%":
          return right === 0 ? 0 : left % right;
        case "^":
          return Math.pow(left, right);
        case ">":
          return left > right ? 1 : 0;
        case ">=":
          return left >= right ? 1 : 0;
        case "<":
          return left < right ? 1 : 0;
        case "<=":
          return left <= right ? 1 : 0;
        case "==":
          return left === right ? 1 : 0;
        case "!=":
          return left !== right ? 1 : 0;
        default:
          return 0;
      }
    }
    case "call":
      return evaluateCall(expr, scope);
  }
}

function evaluateCall(expr: Extract<Expr, { kind: "call" }>, scope: EvalScope): number {
  const name = expr.name;

  if (isAggregate(name)) {
    const body = expr.args[0] as Expr;
    const torrents = [...(scope.user ? [] : [])];
    void torrents;
    const rows = (scope as EvalScope & { torrents?: FormulaTorrent[] }).torrents ?? [];
    if (name === "count") return rows.length;
    if (rows.length === 0) return 0;
    let total = 0;
    let best = name === "max_t" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    for (const torrent of rows) {
      const value = numeric(evaluateExpr(body, { ...scope, torrent }), body);
      total += value;
      if (value > best) best = value;
      if (name === "min_t" && value < best) best = value;
    }
    if (name === "sum") return total;
    if (name === "avg") return total / rows.length;
    return best;
  }

  if (name === "if") {
    const condition = evaluateExpr(expr.args[0] as Expr, scope);
    return condition !== 0
      ? evaluateExpr(expr.args[1] as Expr, scope)
      : evaluateExpr(expr.args[2] as Expr, scope);
  }

  const values = expr.args.map((arg) => evaluateExpr(arg, scope));
  switch (name) {
    case "min":
      return Math.min(values[0] ?? 0, values[1] ?? 0);
    case "max":
      return Math.max(values[0] ?? 0, values[1] ?? 0);
    case "abs":
      return Math.abs(values[0] ?? 0);
    case "sqrt":
      return Math.sqrt(values[0] ?? 0);
    case "pow":
      return Math.pow(values[0] ?? 0, values[1] ?? 0);
    case "exp":
      return Math.exp(values[0] ?? 0);
    case "log10":
      return Math.log10(values[0] ?? 0);
    case "atan":
      return Math.atan(values[0] ?? 0);
    case "round":
      return roundHalfAway(values[0] ?? 0, values[1] ?? 0);
    case "floor": {
      const digits = values[1] ?? 0;
      const factor = 10 ** Math.max(-12, Math.min(12, digits));
      return Math.floor((values[0] ?? 0) * factor) / factor;
    }
    case "ceil": {
      const digits = values[1] ?? 0;
      const factor = 10 ** Math.max(-12, Math.min(12, digits));
      return Math.ceil((values[0] ?? 0) * factor) / factor;
    }
    case "trunc":
      return truncDigits(values[0] ?? 0, values[1] ?? 0);
    default:
      throw new FormulaError(`未知函数：${name}`, expr.line, expr.column);
  }
}

export function evaluateFormula(
  source: string,
  context: FormulaContext,
  options: { maxRows?: number } = {},
): FormulaEvaluation {
  const program = compileFormula(source);
  const maxRows = Math.max(1, Math.min(200, options.maxRows ?? 200));
  const torrents = [...context.torrents]
    .sort((a, b) => b.sizeBytes - a.sizeBytes || a.id - b.id)
    .slice(0, maxRows);

  const scope: EvalScope & { torrents: FormulaTorrent[] } = {
    variables: new Map(),
    user: context.user,
    torrents,
  };
  const variables: Record<string, number> = {};
  const warnings: string[] = [];
  const torrentTerms: FormulaTorrentTerm[] = [];

  for (const statement of program.statements) {
    let value: number;
    if (statement.expr.kind === "call" && isAggregate(statement.expr.name)) {
      // 记录逐种子拆解，便于预览。
      const aggregate = statement.expr;
      const body = aggregate.args[0] as Expr;
      for (const torrent of torrents) {
        const term = evaluateExpr(body, { ...scope, torrent });
        torrentTerms.push({
          id: torrent.id,
          size_gb: torrent.sizeBytes / 1024 ** 3,
          age_weeks: torrent.ageWeeks,
          seeders: torrent.seeders,
          weight: torrent.zeroBonus ? 0.2 : 1,
          term,
        });
      }
      value = evaluateExpr(aggregate, scope);
    } else {
      value = evaluateExpr(statement.expr, scope);
    }
    value = numeric(value, statement.expr);
    scope.variables.set(statement.name, value);
    variables[statement.name] = value;
  }

  const result = variables.result;
  if (result === undefined) {
    warnings.push("未给 result 赋值，按 0 处理");
  }
  const final = result ?? 0;
  if (!Number.isFinite(final)) throw new FormulaError("result 必须是有限数", 1, 1);

  return {
    result: final,
    variables,
    torrents: torrentTerms,
    warnings,
  };
}

export function validateFormula(source: string): { ok: true } | { ok: false; message: string; line: number; column: number } {
  try {
    compileFormula(source);
    return { ok: true };
  } catch (error) {
    if (error instanceof FormulaError) {
      return { ok: false, message: error.message, line: error.line, column: error.column };
    }
    return { ok: false, message: error instanceof Error ? error.message : "公式无效", line: 1, column: 1 };
  }
}

/** 供预览的固定样例；不依赖数据库。 */
export function sampleFormula(source: string): FormulaEvaluation {
  const torrents: FormulaTorrent[] = [
    { id: 1, sizeBytes: 40 * 1024 ** 3, ageWeeks: 3, ageDays: 21, seeders: 2, zeroBonus: false },
    { id: 2, sizeBytes: 12 * 1024 ** 3, ageWeeks: 20, ageDays: 140, seeders: 8, zeroBonus: true },
  ];
  return evaluateFormula(source, {
    user: {
      seeders: 2,
      totalGb: 52,
      totalBytes: 52 * 1024 ** 3,
      avgSizeGb: 26,
      uploaded: 0,
      downloaded: 0,
      ratio: 0,
      ageDays: 30,
      bonus: 0,
      isDonor: false,
      hour: 12,
      dayOfWeek: 1,
      userId: 1,
    },
    torrents,
  });
}
