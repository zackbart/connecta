export const fixtures = [
  {
    id: "valid-js",
    group: "javascript",
    code: "const value = 40; return value + 2;",
    expected: 42,
  },
  {
    id: "annotation",
    group: "candidate",
    code: "const value: number = 40; return value + 2;",
    expected: 42,
  },
  {
    id: "return-type",
    group: "candidate",
    code: "const answer = (): number => 42; return answer();",
    expected: 42,
  },
  {
    id: "as-assertion",
    group: "candidate",
    code: "const value = 42 as number; return value;",
    expected: 42,
  },
  {
    id: "type-alias",
    group: "candidate",
    code: "type Count = number; const value: Count = 42; return value;",
    expected: 42,
  },
  {
    id: "interface",
    group: "candidate",
    code: "interface Box { value: number } const box: Box = { value: 42 }; return box.value;",
    expected: 42,
  },
  {
    id: "erased-generic",
    group: "candidate",
    code: "const identity = <T>(value: T): T => value; return identity<number>(42);",
    expected: 42,
  },
  {
    id: "malformed-ts",
    group: "malformed",
    code: "const value: = 42; return value;",
  },
  {
    id: "fenced-ts",
    group: "candidate",
    code: "```typescript\nconst value: number = 42;\nreturn value;\n```",
    expected: 42,
  },
  {
    id: "enum",
    group: "unsupported",
    code: "enum Answer { Value = 42 } return Answer.Value;",
  },
  {
    id: "decorator",
    group: "unsupported",
    code: "const mark = (value: unknown) => value; @mark class Answer {} return 42;",
  },
  {
    id: "namespace",
    group: "unsupported",
    code: "namespace Answer { export const value = 42 } return Answer.value;",
  },
  {
    id: "jsx",
    group: "unsupported",
    code: "const node = <div>42</div>; return node;",
  },
  {
    id: "import",
    group: "unsupported",
    code: "import value from 'elsewhere'; return value;",
  },
];
