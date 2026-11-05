import type { ToolArguments, ToolContext } from "./types";

// The strong models can write their own JavaScript or Python for what their
// tools and the summary cannot answer, e.g. the mean of a gene in each
// cluster. The code runs in a sandbox like the scripts of skills (Python in
// Pyodide, see python-sandbox.ts), and the user sees it in the chat before it
// runs.

/** The longest title of the code, as the chat shows it, in characters */
const maxTitle = 80;

/** The languages that run_code runs */
const languages = ["javascript", "python"] as const;

/** The run_code tool, only offered to OpenAI and Anthropic */
export const runCodeDefinition = {
  type: "function",
  function: {
    name: "run_code",
    description:
      "Run JavaScript or Python that you write, to compute anything on the data of the tables that the summary does not answer: " +
      "statistics, comparisons, correlations, thresholds, spatial analyses with the coordinates. No skill is needed. " +
      "It runs in a sandbox, where it can read the data of the project but not change it; the user sees its code. " +
      "Returns what the code returns, and what it logs or prints.",
    parameters: {
      type: "object",
      required: ["title", "code"],
      properties: {
        title: {
          type: "string",
          description:
            'What the code computes, in a few words, shown to the user, e.g. "cells per cluster".',
        },
        language: {
          type: "string",
          enum: languages,
          description:
            'The language of the code: "javascript" (the default) or "python".',
        },
        code: {
          type: "string",
          description:
            "JavaScript: a module, export default async function (tm) { ... }. " +
            "Python: a function async def main(tm): ... Either returns a small result.",
        },
      },
    },
  },
};

/** The save_computed_table tool, only offered to OpenAI and Anthropic */
export const saveComputedTableDefinition = {
  type: "function",
  function: {
    name: "save_computed_table",
    description:
      'Keep a table computed by the chat (e.g. "cells (chat)"), which is temporary, as a CSV file next to the project file, ' +
      "after the user confirms; or download it, when the project was not opened from a connected folder. " +
      "Only when the user asks to keep or save it.",
    parameters: {
      type: "object",
      required: ["table"],
      properties: {
        table: {
          type: "string",
          description: 'The name of the table, e.g. "cells (chat)".',
        },
      },
    },
  },
};

/** What the strong models are told about run_code, with the fixed instructions */
export const codeInstructions = [
  "# Your own code",
  "With run_code you can compute anything on the data of the tables yourself: you write",
  "JavaScript or Python, and it runs at once. You need no skill for it. Use it whenever a",
  "question needs a computation that the summary does not answer, e.g.:",
  "- statistics: counts, sums, means, medians, standard deviations, quantiles, for all the",
  "  rows or for each group (e.g. each cluster or cell type);",
  "- comparisons between groups, columns or genes, e.g. which genes are higher in one",
  "  cluster than in the others, with a statistical test;",
  "- correlations between columns or genes;",
  "- thresholds: e.g. how many cells have a value above a limit, and in which groups;",
  "- spatial analyses with the coordinates of the cells or points (columns such as x and y,",
  '  or a matrix such as "obsm/spatial", whose columns are "obsm/spatial[0]" and',
  '  "obsm/spatial[1]"): distances, neighbors, density, which groups lie near each other.',
  "Skills are useful but not needed: when a skill that is on does the task, use it, since it",
  "holds the method the user wants; otherwise write the code yourself. When the user asks",
  "what analyses are possible, tell them all this, and never that a skill is needed first.",
  "",
  "JavaScript or Python:",
  '- JavaScript (language "javascript", the default) starts at once. Use it for counts,',
  "  sums, means and other simple computations. It has no libraries: write what you need.",
  '- Python (language "python") has numpy, scipy, pandas, scikit-learn, statsmodels and the',
  "  other packages of Pyodide. Use it for statistical tests (e.g. scipy.stats), models,",
  "  clustering, or neighbors with scipy.spatial.cKDTree. The first Python code of a chat",
  "  takes some seconds to start, and the first time also to download Python (tens of MB):",
  "  do not use it for what JavaScript does as well.",
  "",
  "JavaScript must be a module: export default async function (tm) { ... }. Python must",
  "define async def main(tm): ... With tm it can read the data:",
  "- await tm.tables(): the tables, as [{ id, name }] (dicts in Python)",
  "- await tm.columns(table): the columns of a table, as [{ name, matrix }]; matrix is true",
  '  for a matrix such as "X" or "obsm/spatial", whose columns await tm.columns(table, "X")',
  '  lists (e.g. "X[EPCAM]")',
  '- await tm.read(table, column): the values of a column (e.g. "obs/leiden" or "X[EPCAM]"),',
  "  one per row, in the order of the rows of the table, so that the values of two columns",
  "  of the same table belong together row by row; in Python, a numpy array (of objects,",
  "  for text such as cluster names)",
  "- tm.project: a copy of the app state, the same JSON as in the context",
  "- tm.progress(text): shows how far it is, for long computations",
  "- await tm.saveColumn(table, name, values) in JavaScript, await tm.save_column(table,",
  "  name, values) in Python: saves a result as a column, one value per row of the table, in",
  "  the order of tm.read (or with the item IDs of the values: { ids } in JavaScript, ids=",
  '  in Python, for some of the items only), into the table "<table> (chat)", which the',
  "  chat makes for it",
  "",
  "# Results on the image",
  "To show a result on the image, e.g. to color the cells by the number of their",
  "neighbors, or to show only the cells near a cluster, save it with tm.saveColumn (or",
  "tm.save_column) in the same code, then use your tools with that column like any other,",
  "e.g. color_by_column with its name: numbers get a color scale, text gets one color per",
  'group. To filter (show_only_groups), save groups as text, e.g. "near" and "far". A',
  "saved column never changes the data of the project, and Undo takes it back. It is",
  "temporary: it is lost when the page is reloaded, unless the user keeps the table with",
  "save_computed_table, which writes it as a CSV file next to the project file (or",
  "downloads it). Say so when you save one. At most 20 columns can be saved in all.",
  "",
  "Use the table ids or names and the column names of the summary, or list them with",
  "tm.tables() and tm.columns() first. Tell the user which method you used, e.g. which",
  "test. The code may run for at most two minutes (in Python, the start and the download do",
  "not count): in big tables go over the rows only a few times, and for neighbors use a",
  "grid or a k-d tree instead of comparing every pair.",
  "",
  "What you cannot do yet: read the pixels of images, or draw charts or plots (the result",
  "is text: give the numbers, or a small table, in your answer). The code has no internet:",
  "it cannot download anything, and in Python only the packages of Pyodide can be imported",
  "(no pip or micropip, and no packages such as squidpy or scanpy). It cannot change the",
  "data of the project or save files: it can only save columns with tm.saveColumn. When a",
  "request needs one of these, say so, and offer what you can do instead.",
  "Return a small result (counts, summaries, a small DataFrame, at most a few hundred",
  "values), never whole columns: it comes back to you as text, and what the code logs with",
  "console.log or print comes along. The code runs in a sandbox: no network, and it cannot",
  "change the project. It is stopped after two minutes, or when the user clicks Stop. The",
  "user sees the code: keep it short and clear. If it fails, fix it once; if it fails",
  "again, tell the user why. Never make up a result that the code did not return.",
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
  const language = args["language"] ?? "javascript";
  if (!languages.some((known) => known === language)) {
    return `Error: run_code runs "javascript" or "python", not ${JSON.stringify(language)}.`;
  }
  const python = language === "python";
  const code = args["code"];
  if (typeof code !== "string" || code.trim() === "") {
    return python
      ? "Error: code is missing: give Python with a function async def main(tm): ..."
      : "Error: code is missing: give a JavaScript module, export default async function (tm) { ... }.";
  }
  const given = args["title"];
  const title =
    (typeof given === "string" ? given.trim().replace(/\s+/g, " ") : "") ||
    "code";
  return context.runCode(
    title.length > maxTitle ? `${title.slice(0, maxTitle - 1)}…` : title,
    code,
    python ? "python" : "javascript",
    { signal, progress: context.progress, changes: context.changes },
  );
}

/**
 * Runs the save_computed_table tool: lets the panel keep a table computed by
 * the chat as a CSV file, or download it
 *
 * @param args - The arguments of the tool call
 * @param context - How to keep a table
 * @returns The result for the model
 */
export function saveComputedTableTool(
  args: ToolArguments,
  context: ToolContext,
): Promise<string> {
  const table = args["table"];
  if (typeof table !== "string" || table.trim() === "") {
    return Promise.resolve(
      'Error: give the name of the table, e.g. "cells (chat)".',
    );
  }
  return context.keepComputedTable(table.trim());
}
