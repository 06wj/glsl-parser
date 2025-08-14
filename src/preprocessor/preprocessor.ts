import { NodeVisitor, Path, visit } from '../ast/visit.js';
import {
  PreprocessorAstNode,
  PreprocessorElseIfNode,
  PreprocessorIdentifierNode,
  PreprocessorIfNode,
  PreprocessorLiteralNode,
  PreprocessorSegmentNode,
} from './preprocessor-node.js';

export type PreprocessorProgram = {
  type: string;
  program: PreprocessorSegmentNode[];
  wsEnd?: string;
};

const without = (obj: object, ...keys: string[]) =>
  Object.entries(obj).reduce(
    (acc, [key, value]) => ({
      ...acc,
      ...(!keys.includes(key) && { [key]: value }),
    }),
    {}
  );

// Scan for the use of a function-like macro, balancing parentheses until
// encountering a final closing ")" marking the end of the macro use
const scanFunctionArgs = (
  src: string
): { args: string[]; length: number } | null => {
  let char: string;
  let parens: number = 0;
  let args: string[] = [];
  let arg: string = '';

  for (let i = 0; i < src.length; i++) {
    char = src.charAt(i);

    if (char === '(') {
      parens++;
    }

    if (char === ')') {
      parens--;
    }

    if (parens === -1) {
      // In the case of "()", we don't want to add the argument of empty string,
      // but we do in case of "(,)" and "(asdf)". When we hit the closing paren,
      // only capture the arg of empty string if there was a previous comma,
      // which we can infer from there being a previous arg
      if (arg !== '' || args.length) {
        args.push(arg);
      }
      return { args, length: i };
    }

    if (char === ',' && parens === 0) {
      args.push(arg);
      arg = '';
    } else {
      arg += char;
    }
  }

  return null;
};

// From glsl2s https://github.com/cimaron/glsl2js/blob/4046611ac4f129a9985d74704159c41a402564d0/preprocessor/comments.js
const preprocessComments = (src: string): string => {
  let i;
  let chr;
  let la;
  let out = '';
  let line = 1;
  let in_single = 0;
  let in_multi = 0;

  for (i = 0; i < src.length; i++) {
    chr = src.substring(i, i + 1);
    la = src.substring(i + 1, i + 2);

    // Enter single line comment
    if (chr == '/' && la == '/' && !in_single && !in_multi) {
      in_single = line;
      i++;
      continue;
    }

    // Exit single line comment
    if (chr == '\n' && in_single) {
      in_single = 0;
    }

    // Enter multi line comment
    if (chr == '/' && la == '*' && !in_multi && !in_single) {
      in_multi = line;
      i++;
      continue;
    }

    // Exit multi line comment
    if (chr == '*' && la == '/' && in_multi) {
      // Treat single line multi-comment as space
      if (in_multi == line) {
        out += ' ';
      }

      in_multi = 0;
      i++;
      continue;
    }

    // Newlines are preserved
    if ((!in_multi && !in_single) || chr == '\n') {
      out += chr;
      line++;
    }
  }

  return out;
};

const tokenPaste = (str: string): string => str.replace(/\s+##\s+/g, '');

type NodeEvaluator<NodeType> = (
  node: NodeType,
  visit: (node: PreprocessorAstNode) => any
) => any;

export type NodeEvaluators = Partial<
  {
    [NodeType in PreprocessorAstNode['type']]: NodeEvaluator<
      Extract<PreprocessorAstNode, { type: NodeType }>
    >;
  }
>;

const evaluate = (ast: PreprocessorAstNode, evaluators: NodeEvaluators) => {
  const visit = (node: PreprocessorAstNode) => {
    const evaluator = evaluators[node.type];
    if (!evaluator) {
      throw new Error(`No evaluate() evaluator for ${node.type}`);
    }

    // I can't figure out why evalutor has node type never here
    // @ts-ignore
    return evaluator(node, visit);
  };
  return visit(ast);
};

export type Macro = {
  args?: PreprocessorAstNode[];
  body: string;
};

export type Macros = {
  [name: string]: Macro;
};

const expandFunctionMacro = (
  macros: Macros,
  macroName: string,
  macro: Macro,
  text: string
) => {
  const pattern = `\\b${macroName}\\s*\\(`;
  const startRegex = new RegExp(pattern, 'm');

  let expanded = '';
  let current = text;
  let startMatch;

  while ((startMatch = startRegex.exec(current))) {
    const result = scanFunctionArgs(
      current.substring(startMatch.index + startMatch[0].length)
    );
    if (result === null) {
      throw new Error(
        `${current.match(startRegex)} unterminated macro invocation`
      );
    }
    const macroArgs = (macro.args || []).filter(
      (arg) => (arg as PreprocessorLiteralNode).literal !== ','
    );
    const { args, length: argLength } = result;

    // The total length of the raw text to replace is the macro name in the
    // text (startMatch), plus the length of the arguments, plus one to
    // encompass the closing paren that the scan fn skips
    const matchLength = startMatch[0].length + argLength + 1;

    if (args.length > macroArgs.length) {
      throw new Error(`'${macroName}': Too many arguments for macro`);
    }
    if (args.length < macroArgs.length) {
      throw new Error(`'${macroName}': Not enough arguments for macro`);
    }

    // Collect the macro identifiers and build a replacement map from those to
    // the user defined replacements
    const argIdentifiers = macroArgs.map(
      (a) => (a as PreprocessorIdentifierNode).identifier
    );

    const argKeys = argIdentifiers.reduce<Record<string, string>>(
      (acc, identifier, index) => ({
        ...acc,
        // We are scanning from the outside in - so fn(args) - we need to
        // recursivey test if args itself has macros to expand. We don't need
        // to remove the current macroName from macros because we are scanning
        // outside in, so self-referencing macros won't get into an infinite
        // loop here
        [identifier]: expandMacros(args[index].trim(), macros),
      }),
      {}
    );

    const replacedBody = tokenPaste(
      macro.body.replace(
        // Replace all instances of macro arguments in the macro definition
        // (the arg separated by word boundaries) with its user defined
        // replacement. This one-pass strategy ensures that we won't clobber
        // previous replacements when the user supplied args have the same names
        // as the macro arguments
        new RegExp(
          '(' + argIdentifiers.map((a) => `\\b${a}\\b`).join(`|`) + ')',
          'g'
        ),
        (match) => (match in argKeys ? argKeys[match] : match)
      )
    );

    // Any text expanded is then scanned again for more replacements. The
    // self-reference rule means that a macro that references itself won't be
    // expanded again, so remove it from the search. WARNING! There is a known
    // bug here! See the xtest in preprocessor.test.ts.
    const expandedReplace = expandMacros(
      replacedBody,
      without(macros, macroName)
    );

    // We want to break this string at where we finished expanding the macro
    const endOfReplace = startMatch.index + expandedReplace.length;

    // Replace the use of the macro with the expansion
    const processed = current.replace(
      current.substring(startMatch.index, startMatch.index + matchLength),
      expandedReplace
    );

    // Add text up to the end of the expanded macro to what we've procssed
    expanded += processed.substring(0, endOfReplace);

    // Only work on the rest of the text, not what we already expanded. This is
    // to avoid a nested macro #define foo() foo() where we'll try to expand foo
    // forever. With this strategy, we expand foo() to foo() and move on
    current = processed.substring(endOfReplace);
  }

  return expanded + current;
};

const expandObjectMacro = (
  macros: Macros,
  macroName: string,
  macro: Macro,
  text: string
) => {
  const regex = new RegExp(`\\b${macroName}\\b`, 'g');
  let expanded = text;
  if (regex.test(text)) {
    // Macro definitions like
    //     #define MACRO
    // Have null for the body. Make it empty string if null to avoid 'null' expanded
    const replacement = macro.body || '';

    // Recursively scan this macro body for more replacements, ignoring our own
    // macro to avoid the self-reference rule.
    const scanned = expandMacros(replacement, without(macros, macroName));

    expanded = tokenPaste(
      text.replace(new RegExp(`\\b${macroName}\\b`, 'g'), scanned)
    );
  }
  return expanded;
};

const expandMacros = (text: string, macros: Macros) =>
  Object.entries(macros).reduce(
    (result, [macroName, macro]) =>
      macro.args
        ? expandFunctionMacro(macros, macroName, macro, result)
        : expandObjectMacro(macros, macroName, macro, result),
    text
  );

const isTruthy = (x: any): boolean => !!x;

// Given an expression AST node, visit it to expand the macro macros to in the
// right places
const expandInExpressions = (
  macros: Macros,
  ...expressions: PreprocessorAstNode[]
) => {
  expressions.forEach((expression) => {
    visitPreprocessedAst(expression, {
      unary_defined: {
        enter: (path) => {
          path.skip();
        },
      },
      identifier: {
        enter: (path) => {
          path.node.identifier = expandMacros(path.node.identifier, macros);
        },
      },
    });
  });
};

const evaluateIfPart = (macros: Macros, ifPart: PreprocessorAstNode) => {
  if (ifPart.type === 'if') {
    return evaluteExpression(ifPart.expression, macros);
  } else if (ifPart.type === 'ifdef') {
    return ifPart.identifier.identifier in macros;
  } else if (ifPart.type === 'ifndef') {
    return !(ifPart.identifier.identifier in macros);
  }
};

// TODO: Are all of these operators equivalent between javascript and GLSL?
const evaluteExpression = (node: PreprocessorAstNode, macros: Macros) =>
  evaluate(node, {
    // TODO: Handle non-base-10 numbers. Should these be parsed in the peg grammar?
    int_constant: (node) => parseInt(node.token, 10),
    unary_defined: (node) => node.identifier.identifier in macros,
    identifier: (node) => node.identifier,
    group: (node, visit) => visit(node.expression),
    binary: ({ left, right, operator: { literal } }, visit) => {
      switch (literal) {
        // multiplicative
        case '*': {
          return visit(left) * visit(right);
        }
        // division
        case '/': {
          return visit(left) / visit(right);
        }
        // modulo
        case '%': {
          return visit(left) % visit(right);
        }
        // addition
        case '+': {
          return visit(left) + visit(right);
        }
        // subtraction
        case '-': {
          return visit(left) - visit(right);
        }
        // bit-wise shift
        case '<<': {
          return visit(left) << visit(right);
        }
        // bit-wise shift
        case '>>': {
          return visit(left) >> visit(right);
        }
        case '<': {
          return visit(left) < visit(right);
        }
        case '>': {
          return visit(left) > visit(right);
        }
        case '<=': {
          return visit(left) <= visit(right);
        }
        case '>=': {
          return visit(left) >= visit(right);
        }
        case '==': {
          return visit(left) == visit(right);
        }
        case '!=': {
          return visit(left) != visit(right);
        }
        // bit-wise and
        case '&': {
          return visit(left) & visit(right);
        }
        // bit-wise exclusive or
        case '^': {
          return visit(left) ^ visit(right);
        }
        // bit-wise inclusive or
        case '|': {
          return visit(left) | visit(right);
        }
        case '&&': {
          return visit(left) && visit(right);
        }
        case '||': {
          return visit(left) || visit(right);
        }
        default: {
          throw new Error(
            `Preprocessing error: Unknown binary operator ${literal}`
          );
        }
      }
    },
    unary: (node, visit) => {
      switch (node.operator.literal) {
        case '+': {
          return visit(node.expression);
        }
        case '-': {
          return -1 * visit(node.expression);
        }
        case '!': {
          return !visit(node.expression);
        }
        case '~': {
          return ~visit(node.expression);
        }
        default: {
          throw new Error(
            `Preprocessing error: Unknown unary operator ${node.operator.literal}`
          );
        }
      }
    },
  });

const shouldPreserve = (preserve: NodePreservers = {}) => (
  path: PathOverride<PreprocessorAstNode>
) => {
  const test = preserve?.[path.node.type];
  return typeof test === 'function' ? test(path) : test;
};

// HACK: The AST visitors are hard coded to the GLSL AST (not preprocessor AST)
// types. I'm not clever enough to make the core AST type geneeric so that both
// GLSL AST (in ast.ts) and the preprocessed AST can use the same
// visitor/evaluator/path pattern. I took a stab at it but it become tricky to
// track all the nested generics. Instead, I hack re-cast the visit function
// here, which at least gives some minor type safety.
type VisitorOverride = (
  ast: PreprocessorAstNode | PreprocessorProgram,
  visitors: {
    [NodeType in PreprocessorAstNode['type']]?: NodeVisitor<
      Extract<PreprocessorAstNode, { type: NodeType }>
    >;
  }
) => void;

// @ts-ignore
export const visitPreprocessedAst = visit as VisitorOverride;

type PathOverride<NodeType> = {
  node: NodeType;
  parent: PreprocessorAstNode | undefined;
  parentPath: Path<any> | undefined;
  key: string | undefined;
  index: number | undefined;
  skip: () => void;
  remove: () => void;
  replaceWith: (replacer: PreprocessorAstNode) => void;
  findParent: (test: (p: Path<any>) => boolean) => Path<any> | undefined;

  skipped?: boolean;
  removed?: boolean;
  replaced?: any;
};
const convertPath = (p: Path<any>) =>
  (p as unknown) as PathOverride<typeof p['node']>;

/**
 * Perform the preprocessing logic, aka the "preprocessing" phase of the compiler.
 * Expand macros, evaluate conditionals, etc
 * TODO: Define the strategy for conditionally removing certain macro types
 * and conditionally expanding certain expressions. And take in optiona list
 * of pre defined thigns?
 * TODO: Handle __LINE__ and other constants.
 */

export type NodePreservers = {
  [nodeType: string]: (path: PathOverride<any>) => boolean;
};

export type PreprocessorOptions = {
  defines?: { [definitionName: string]: Object };
  preserve?: NodePreservers;
  preserveComments?: boolean;
  stopOnError?: boolean;
  grammarSource?: string;
};

// Remove escaped newlines, rather than try to handle them in the grammar
const unescapeSrc = (src: string, options: PreprocessorOptions = {}) =>
  src.replace(/\\[\n\r]/g, '');

const preprocessAst = (
  program: PreprocessorProgram,
  options: PreprocessorOptions = {}
) => {
  const macros: Macros = Object.entries(options.defines || {}).reduce(
    (defines, [name, body]) => ({ ...defines, [name]: { body } }),
    {}
  );

  const { preserve } = options;
  const preserveNode = shouldPreserve(preserve);

  visitPreprocessedAst(program, {
    conditional: {
      enter: (initialPath) => {
        const path = convertPath(initialPath);
        const { node } = path;
        // TODO: Determining if we need to handle edge case conditionals here
        if (preserveNode(path)) {
          return;
        }

        // Expand macros in if/else *expressions* only. Macros are expanded in:
        //     #if X + 1
        //     #elif Y + 2
        // But *not* in
        //     # ifdef X
        // Because X should not be expanded in the ifdef. Note that
        //     # if defined(X)
        // does have an expression, but the skip() in unary_defined prevents
        // macro expansion in there. Checking for .expression and filtering out
        // any conditionals without expressions is how ifdef is avoided.
        // It's not great that ifdef is skipped differentaly than defined().
        expandInExpressions(
          macros,
          ...[
            (node.ifPart as PreprocessorIfNode).expression,
            ...node.elseIfParts.map(
              (elif: PreprocessorElseIfNode) => elif.expression
            ),
          ].filter(isTruthy)
        );

        if (evaluateIfPart(macros, node.ifPart)) {
          path.replaceWith(node.ifPart.body);
        } else {
          const elseBranchHit = node.elseIfParts.reduce(
            (res: boolean, elif: PreprocessorElseIfNode) =>
              res ||
              (evaluteExpression(elif.expression, macros) &&
                // path/visit hack to remove type error
                (path.replaceWith(elif.body as PreprocessorAstNode), true)),
            false
          );
          if (!elseBranchHit) {
            if (node.elsePart) {
              path.replaceWith(node.elsePart.body as PreprocessorAstNode);
            } else {
              path.remove();
            }
          }
        }
      },
    },
    text: {
      enter: (initialPath) => {
        const path = convertPath(initialPath);
        path.node.text = expandMacros(path.node.text, macros);
      },
    },
    define_arguments: {
      enter: (initialPath) => {
        const path = convertPath(initialPath);
        const {
          identifier: { identifier },
          body,
          args,
        } = path.node;

        macros[identifier] = { args, body };
        !preserveNode(path) && path.remove();
      },
    },
    define: {
      enter: (initialPath) => {
        const path = convertPath(initialPath);
        const {
          identifier: { identifier },
          body,
        } = path.node;

        macros[identifier] = { body };
        !preserveNode(path) && path.remove();
      },
    },
    undef: {
      enter: (initialPath) => {
        const path = convertPath(initialPath);
        delete macros[path.node.identifier.identifier];
        !preserveNode(path) && path.remove();
      },
    },
    error: {
      enter: (initialPath) => {
        const path = convertPath(initialPath);
        if (options.stopOnError) {
          throw new Error(path.node.message);
        }
        !preserveNode(path) && path.remove();
      },
    },
    pragma: {
      enter: (initialPath) => {
        const path = convertPath(initialPath);
        !preserveNode(path) && path.remove();
      },
    },
    version: {
      enter: (initialPath) => {
        const path = convertPath(initialPath);
        !preserveNode(path) && path.remove();
      },
    },
    extension: {
      enter: (initialPath) => {
        const path = convertPath(initialPath);
        !preserveNode(path) && path.remove();
      },
    },
    // TODO: Causes a failure
    line: {
      enter: (initialPath) => {
        const path = convertPath(initialPath);
        !preserveNode(path) && path.remove();
      },
    },
  });

  // Even though it mutates, useful for passing around functions
  return program;
};

export { preprocessAst, preprocessComments, unescapeSrc };
