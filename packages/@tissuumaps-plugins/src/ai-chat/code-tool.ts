import type { ToolArguments, ToolContext } from "./types";

// The strong models can write their own JavaScript for what their tools and
// the summary cannot answer, e.g. the mean of a gene in each cluster. The code
// runs in the same sandbox as the scripts of skills, and the user sees it in
// the chat before it runs.

/** The longest title of the code, as the chat shows it, in characters */
const maxTitle = 80;

/** The run_code tool, only offered to OpenAI and Anthropic */
export const runCodeDefinition = {
  type: "function",
  function: {
    name: "run_code",
    description:
      "Run JavaScript that you write, to compute anything on the data of the tables that the summary does not answer: " +
      "statistics, comparisons, correlations, thresholds, spatial analyses with the coordinates. No skill is needed. " +
      "It runs in a sandbox, where it can read the data of the project but not change it; the user sees its code. " +
      "Returns what the code returns, and what it logs.",
    parameters: {
      type: "object",
      required: ["title", "code"],
      properties: {
        title: {
          type: "string",
          description:
            'What the code computes, in a few words, shown to the user, e.g. "cells per cluster".',
        },
        code: {
          type: "string",
          description:
            "A JavaScript module: export default async function (tm) { ... }, which returns a small result.",
        },
      },
    },
  },
};

/** What the strong models are told about run_code, with the fixed instructions */
export const codeInstructions = [
  "# Your own code",
  "With run_code you can compute anything on the data of the tables yourself: you write",
  "JavaScript, and it runs at once. You need no skill for it. Use it whenever a question",
  "needs a computation that the summary does not answer, e.g.:",
  "- statistics: counts, sums, means, medians, standard deviations, quantiles, for all the",
  "  rows or for each group (e.g. each cluster or cell type);",
  "- comparisons between groups, columns or genes, e.g. which genes are higher in one",
  "  cluster than in the others, or a statistical test that you write yourself;",
  "- correlations between columns or genes;",
  "- thresholds: e.g. how many cells have a value above a limit, and in which groups;",
  "- spatial analyses with the coordinates of the cells or points (columns such as x and y,",
  '  or a matrix such as "obsm/spatial", whose columns are "obsm/spatial[0]" and',
  '  "obsm/spatial[1]"): distances, neighbors, density, which groups lie near each other.',
  "Skills are useful but not needed: when a skill that is on does the task, use it, since it",
  "holds the method the user wants; otherwise write the code yourself. When the user asks",
  "what analyses are possible, tell them all this, and never that a skill is needed first.",
  "The code must be a module: export default async function (tm) { ... }. With tm it can",
  "read the data:",
  "- await tm.tables(): the tables, as [{ id, name }]",
  "- await tm.columns(table): the columns of a table, as [{ name, matrix }]; matrix is true",
  '  for a matrix such as "X" or "obsm/spatial", whose columns await tm.columns(table, "X")',
  '  lists (e.g. "X[EPCAM]")',
  '- await tm.read(table, column): the values of a column (e.g. "obs/leiden" or "X[EPCAM]"),',
  "  one per row, in the order of the rows of the table, so that the values of two columns",
  "  of the same table belong together row by row",
  "- tm.project: a copy of the app state, the same JSON as in the context",
  "- tm.progress(text): shows how far it is, for long computations",
  "Use the table ids or names and the column names of the summary, or list them with",
  "tm.tables() and tm.columns() first. Write plain JavaScript: there are no libraries, so",
  "write the statistics you need yourself (e.g. a rank, a variance, a p-value from a normal",
  "approximation), and tell the user which method you used. The code may run for at most",
  "two minutes: in big tables go over the rows only a few times, and for neighbors put the",
  "cells into a grid instead of comparing every pair.",
  "What you cannot do yet: read the pixels of images, draw charts or plots (the result is",
  "text: give the numbers, or a small table, in your answer), use libraries such as scipy,",
  "numpy or d3, or run Python. The code cannot change the project, add columns to the",
  "tables or save files; to show what it found, use your tools, e.g. show only the groups",
  "it found. When a request needs one of these, say so, and offer what you can do instead.",
  "Return a small result (counts, summaries, at most a few hundred values), never whole",
  "columns: it comes back to you as text, and what the code logs with console.log comes",
  "along. The code runs in a sandbox: no network, no other code, and it cannot change the",
  "project. It is stopped after two minutes, or when the user clicks Stop. The user sees the",
  "code: keep it short and clear. If it fails, fix it once; if it fails again, tell the",
  "user why. Never make up a result that the code did not return.",
].join("\n");

/**
 * Runs the run_code tool: checks the code, then lets the panel run it in the
 * sandbox
 *
 * @param args - The arguments of the tool call
 * @param context - How to run code
 * @param options - Optional abort signal, which stops the code
 * @returns The result for the model
 */
export async function runCodeTool(
  args: ToolArguments,
  context: ToolContext,
  options?: { signal?: AbortSignal },
): Promise<string> {
  const { signal } = options ?? {};
  signal?.throwIfAborted();
  const code = args["code"];
  if (typeof code !== "string" || code.trim() === "") {
    return "Error: code is missing: give a JavaScript module, export default async function (tm) { ... }.";
  }
  const given = args["title"];
  const title =
    (typeof given === "string" ? given.trim().replace(/\s+/g, " ") : "") ||
    "code";
  return context.runCode(
    title.length > maxTitle ? `${title.slice(0, maxTitle - 1)}…` : title,
    code,
    { signal, progress: context.progress },
  );
}
