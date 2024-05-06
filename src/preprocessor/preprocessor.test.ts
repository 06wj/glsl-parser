import fs from 'fs';
import peggy from 'peggy';
import util from 'util';
import {
  preprocessComments,
  preprocessAst,
  PreprocessorProgram,
  visitPreprocessedAst,
  NodeEvaluators,
} from './preprocessor.js';
import generate from './generator.js';
import { GlslSyntaxError } from '../error.js';
import { PreprocessorAstNode } from './preprocessor-node.js';
import { visit } from '../ast/visit.js';

const fileContents = (filePath: string): string =>
  fs.readFileSync(filePath).toString();

const grammar = fileContents('./src/preprocessor/preprocessor-grammar.pegjs');
const parser = peggy.generate(grammar, { cache: true });
const parse = (src: string) => parser.parse(src) as PreprocessorProgram;

const debugProgram = (program: string): void => {
  debugAst(parse(program));
};

const debugAst = (ast: any) => {
  console.log(util.inspect(ast, false, null, true));
};

const expectParsedProgram = (sourceGlsl: string) => {
  const ast = parse(sourceGlsl);
  const glsl = generate(ast);
  if (glsl !== sourceGlsl) {
    debugAst(ast);
    expect(glsl).toBe(sourceGlsl);
  }
};

// test('pre test file', () => {
//   expectParsedProgram(fileContents('./preprocess-test-grammar.glsl'));
// });

test('#preprocessComments', () => {
  // Should strip comments and replace single-line comments with a single space
  expect(
    preprocessComments(`// ccc
/* cc */aaa/* cc */
/**
 * cccc
 */
bbb
`)
  ).toBe(`
 aaa 



bbb
`);
});

test('preprocessor error', () => {
  let error: GlslSyntaxError | undefined;
  try {
    parse(`#if defined(#)`);
  } catch (e) {
    error = e as GlslSyntaxError;
  }

  expect(error).toBeInstanceOf(parser.SyntaxError);
  expect(error!.location.start.line).toBe(1);
  expect(error!.location.end.line).toBe(1);
});

test('preprocessor ast', () => {
  expectParsedProgram(`
#line 0
#version 100 "hi"
#define GL_es_profile 1
#extension all : disable
#error whoopsie
#define A 1
before if
      #if A == 1 || B == 2
      inside if
      #define A
          #elif A == 1 || defined(B) && C == 2
          float a;
          #elif A == 1 || defined(B) && C == 2
          float a;
      #define B
      #endif
outside endif
#pragma mypragma: something(else)
final line after program
`);
});

test('nested expand macro', () => {
  const program = `#define X Y
#define Y Z
X`;

  const ast = parse(program);
  preprocessAst(ast);
  expect(generate(ast)).toBe(`Z`);
});

test('binary evaluation', () => {
  const program = `
#if 1 + 1 > 0
true
#endif
`;

  const ast = parse(program);
  preprocessAst(ast);
  expect(generate(ast)).toBe(`
true
`);
});

test('ifdef inside else is properly expanded', () => {
  // Regression: Make sure #ifdef MACRO inside #else isn't expanded
  const program = `
#define MACRO
#ifdef NOT_DEFINED
  false
#else
  #ifdef MACRO
____true
  #endif
#endif
`;

  const ast = parse(program);
  preprocessAst(ast);
  expect(generate(ast)).toBe(`
____true
`);
});

test('macro without body becoms empty string', () => {
  // There is intentionally whitespace after MACRO to make sure it doesn't apply
  // to the expansion-to-nothing
  const program = `
#define MACRO   
fn(MACRO);
`;

  const ast = parse(program);
  preprocessAst(ast);
  expect(generate(ast)).toBe(`
fn();
`);
});

test('if expression', () => {
  const program = `
#define A
before if
#if !defined(A) && (defined(B) && C == 2)
inside first if
#endif
#if ((defined(B) && C == 2) || defined(A))
inside second if
#endif
after if
`;

  const ast = parse(program);
  preprocessAst(ast);
  expect(generate(ast)).toBe(`
before if
inside second if
after if
`);
});

test('evaluate if branch', () => {
  const program = `
#define A
before if
#if defined(A)
inside if
#endif
after if
`;

  const ast = parse(program);
  preprocessAst(ast);
  expect(generate(ast)).toBe(`
before if
inside if
after if
`);
});

test('evaluate elseif branch', () => {
  const program = `
#define A
before if
#if defined(B)
inside if
#elif defined(A)
inside elif
#else
else body
#endif
after if`;

  const ast = parse(program);
  preprocessAst(ast);
  expect(generate(ast)).toBe(`
before if
inside elif
after if`);
});

test('empty branch', () => {
  const program = `before if
#ifdef GL_ES
precision mediump float;
#endif
after if`;

  const ast = parse(program);

  preprocessAst(ast);
  expect(generate(ast)).toBe(`before if
after if`);
});

test('evaluate else branch', () => {
  const program = `
#define A
before if
#if defined(D)
inside if
#elif defined(E)
inside elif
#else
else body
#endif
after if`;

  const ast = parse(program);
  preprocessAst(ast);
  expect(generate(ast)).toBe(`
before if
else body
after if`);
});

test('self referential object macro', () => {
  const program = `
#define first first second
#define second first
second`;

  // If this has an infinte loop, the test will never finish
  const ast = parse(program);
  preprocessAst(ast);
  expect(generate(ast)).toBe(`
first second`);
});

test('self referential function macro', () => {
  const program = `
#define foo() foo()
foo()`;

  // If this has an infinte loop, the test will never finish
  const ast = parse(program);
  preprocessAst(ast);
  expect(generate(ast)).toBe(`
foo()`);
});

test('self referential macro combinations', () => {
  const program = `
#define b c
#define first(a,b) a + b
#define second first(1,b)
second`;

  // If this has an infinte loop, the test will never finish
  const ast = parse(program);
  preprocessAst(ast);
  expect(generate(ast)).toBe(`
1 + c`);
});

test("function call macro isn't expanded", () => {
  const program = `
#define foo() no expand
foo`;

  const ast = parse(program);
  // debugAst(ast);
  preprocessAst(ast);
  expect(generate(ast)).toBe(`
foo`);
});

test("macro that isn't macro function call call is expanded", () => {
  const program = `
#define foo () yes expand
foo`;

  const ast = parse(program);
  // debugAst(ast);
  preprocessAst(ast);
  expect(generate(ast)).toBe(`
() yes expand`);
});

test('unterminated macro function call', () => {
  const program = `
#define foo() yes expand
foo(
foo()`;

  const ast = parse(program);
  expect(() => preprocessAst(ast)).toThrow(
    'foo( unterminated macro invocation'
  );
});

test('macro function calls with no arguments', () => {
  const program = `
#define foo() yes expand
foo()
foo
()`;

  const ast = parse(program);
  preprocessAst(ast);
  expect(generate(ast)).toBe(`
yes expand
yes expand`);
});

test('macro function calls with bad arguments', () => {
  expect(() => {
    preprocessAst(
      parse(`
      #define foo( a, b ) a + b
      foo(1,2,3)`)
    );
  }).toThrow("'foo': Too many arguments for macro");

  expect(() => {
    preprocessAst(
      parse(`
      #define foo( a ) a + b
      foo(,)`)
    );
  }).toThrow("'foo': Too many arguments for macro");

  expect(() => {
    preprocessAst(
      parse(`
      #define foo( a, b ) a + b
      foo(1)`)
    );
  }).toThrow("'foo': Not enough arguments for macro");
});

test('macro function calls with arguments', () => {
  const program = `
#define foo( a, b ) a + b
foo(x + y, (z-t + vec3(0.0, 1.0)))
foo
(q,
r)
foo(,)`;

  const ast = parse(program);
  preprocessAst(ast);
  expect(generate(ast)).toBe(`
x + y + (z-t + vec3(0.0, 1.0))
q + r
 + `);
});

test('nested function macro expansion', () => {
  const program = `
#define X Z
#define foo(x, y) x + y
foo (foo (a, X), c)`;

  const ast = parse(program);
  preprocessAst(ast);
  expect(generate(ast)).toBe(`
a + Z + c`);
});

test('token pasting', () => {
  const program = `
#define COMMAND(NAME)  { NAME, NAME ## _command ## x ## y }
COMMAND(x)`;

  const ast = parse(program);
  preprocessAst(ast);
  expect(generate(ast)).toBe(`
{ x, x_commandxy }`);
});

test('preservation', () => {
  const program = `
#line 0
#version 100 "hi"
#define GL_es_profile 1
#extension all : disable
#error whoopsie
#define  A 1
before if
#if A == 1 || B == 2
inside if
#define A
#elif A == 1 || defined(B) && C == 2
float a;
#define B
#endif
outside endif
#pragma mypragma: something(else)
function_call line after program`;

  const ast = parse(program);

  preprocessAst(ast, {
    // ignoreMacro: (identifier, body) => {
    //   // return identifier === 'A';
    // },
    preserve: {
      conditional: (path) => false,
      line: (path) => true,
      error: (path) => true,
      extension: (path) => true,
      pragma: (path) => true,
      version: (path) => true,
    },
  });
  expect(generate(ast)).toBe(`
#line 0
#version 100 "hi"
#extension all : disable
#error whoopsie
before if
inside if
outside endif
#pragma mypragma: something(else)
function_call line after program`);
});

test('different line breaks character', () => {
  const program = '#ifndef x\rfloat a = 1.0;\r\n#endif';

  const ast = parse(program);
  preprocessAst(ast);
  expect(generate(ast)).toBe('float a = 1.0;\r\n');
});

test('generate #ifdef & #ifndef & #else', () => {
  const program = `
  #ifdef AA
    float a;
  #else
    float b;
  #endif

  #ifndef CC
    float c;
  #endif

  #if AA == 2
    float d;
  #endif
  `;

  const ast = parse(program);
  expect(generate(ast)).toBe(program);
});

test.only('generate #ifdef & #ifndef & #else', () => {
  const program = `
  #ifdef WEB
    float web_a;
    #define xx
    #if xx
      float web_xx = 1.0;
    #endif
    #if defined(WEB)
      float web_b;
    #endif
  #else
    float native_a;
    #if !defined(WEB) || defined(xxx)
      float native_b;
    #endif
  #endif

  #if defined(WEB) && !defined(NATIVE)
    float web_c;
  #else
    float native_c;
  #endif

  `;

  const ast = parse(program);

  // console.log(JSON.stringify(ast, null, 2))
  
  const macros = {
    WEB: true,
    NATIVE: false
  }
  
  const checkMacros = (identifier: string) => {
    const macrosEntries = Object.entries(macros);
    for (let i = 0; i < macrosEntries.length;i ++) {
      const [key, value] = macrosEntries[i];
      if (key === identifier) {
        return value;
      }
    }
    return null;
  };

  const checkIFPart = (ast: PreprocessorAstNode):boolean|null => {
    switch (ast.type) {
      case 'unary':
        if (ast.operator.literal === '!') {
          const res = checkIFPart(ast.expression);
          if (res !== null) {
            return !res;
          }
        }
        break;
      case 'unary_defined':
        if (ast.operator.literal === 'defined') {
          const macroValue = checkMacros(ast.identifier.identifier);
          if (macroValue !== null) {
            return macroValue;
          }
        }
        break;
      case 'binary':
        const leftResult = checkIFPart(ast.left);
        const rightResult = checkIFPart(ast.right);

        switch(ast.operator.literal) {
          case '&&':
            if (leftResult !== null && rightResult !== null) {
              return leftResult && rightResult;
            } else if (leftResult === false || rightResult === false) {
              return false;
            }
            break;
          case '||':
            if (leftResult !== null && rightResult !== null) {
              return leftResult || rightResult;
            } else if (leftResult === true || rightResult === true) {
              return true;
            }
            break;
        }
        break;
      case 'group':
        return checkIFPart(ast.expression);
    }
    return null;
  };

  visitPreprocessedAst(ast, {
    conditional: {
      enter: function(path) {
        if (path.node.elseIfParts.length > 0) {
          return;
        }

        const ifPart = path.node.ifPart;
        const ifPartType = ifPart.type;
        let ifPartResult:boolean|null = null;
        if (ifPartType === 'ifdef' || ifPartType === 'ifndef') {
          const identifier = ifPart.identifier.identifier;
          const macroValue = checkMacros(identifier);
          if (macroValue !== null) {
            ifPartResult = ifPartType === 'ifdef' ? macroValue : !macroValue;
          }
        } else if (ifPartType === 'if') {
          ifPartResult = checkIFPart(ifPart.expression);
        }

        if (ifPartResult !== null) {
          const body = ifPartResult ? path.node.ifPart.body : path.node.elsePart?.body;
          if (body) {
            path.replaceWith(body as any);
          } else {
            path.remove();
          }
        }
      }
    }
  });
  
  console.log(generate(ast));
});

/*
test('debug', () => {
  const program = `
precision highp float;
precision mediump int;
precision lowp int;
`;

  const ast = parse(program);
  preprocessAst(ast);
  expect(generate(ast)).toBe(`
varying vec2 vUv;
`);
});
*/
