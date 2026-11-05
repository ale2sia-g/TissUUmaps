import {
  type PluginStores,
  type ProjectStore,
  SourceUtils,
  type TableDataSource,
  createTable,
} from "@tissuumaps/core";

import { callActionDefinition, describeAction } from "./call-action";
import {
  codeInstructions,
  runCodeDefinition,
  saveComputedTableDefinition,
} from "./code-tool";
import { overlapWarning } from "./color-tools";
import {
  type ComputedTable,
  type ComputedValues,
  columnValues,
  computedTableCsv,
  computedTableType,
  csvFileName,
  forgetVersions,
  idsSurviveCsv,
  keepVersion,
  maxComputedColumns,
  registerComputedTables,
  suggestCsvName,
  valuesByRow,
  versionOf,
  withComputedTables,
} from "./computed-tables";
import { helpText } from "./help";
import {
  actionLimits,
  instructions,
  toolLimits,
  wholeAppInstructions,
} from "./instructions";
import { renderMarkdown } from "./markdown";
import { findById, isMapKind, same } from "./objects";
import { personaFor } from "./persona";
import { loadProjectSkills } from "./project-skills";
import {
  type ChatAnswer,
  type ChatMessage,
  type OllamaPullUpdate,
  type Provider,
  type ProviderId,
  type Usage,
  explainNotReachable,
  hideKey,
  notRunningMessage,
  ollamaUrl,
  providers,
  readJsonLines,
} from "./providers";
import {
  type DownloadProgress,
  countPythonFiles,
  forgetPythonFiles,
  makePythonFiles,
} from "./python-files";
import { type PythonKernel, startPythonKernel } from "./python-sandbox";
import { type ScriptOutcome, type ScriptQuestion, runScript } from "./sandbox";
import { loadSetting, saveSetting } from "./settings";
import { makeSkillList } from "./skill-list";
import {
  forgetStoredSkill,
  loadStoredSkills,
  storeSkill,
} from "./skill-storage";
import {
  describeSkills,
  skillInstructions,
  skillToolDefinitions,
} from "./skill-tools";
import type { Skill } from "./skills";
import { buildContext, exampleRequests, stateJson } from "./summary";
import {
  describeMatrix,
  describeValues,
  findUsedColumns,
  linkedTables,
  listColumns,
  matrixColumns,
  maxRowsToRead,
  objectTables,
} from "./tables";
import { toolDefinitions, tools, wholeAppTools } from "./tools";
import type {
  Change,
  ColumnInfo,
  ItemsObject,
  RunOptions,
  TableInfo,
  TableKnowledge,
  ToolArguments,
} from "./types";
import {
  type MessageKind,
  controlStyle,
  credits,
  describeCall,
  dollars,
  firstLine,
  makeAvatar,
  makeButton,
  makeCopyButton,
  makeThinkingIndicator,
  messageStyles,
  notReachable,
  quietButtonStyle,
  quietTextStyle,
  smallButtonStyle,
  toolIcons,
  usesOllama,
} from "./ui";
import { currentValue, describeValueChange, handNote, takeBack } from "./undo";

/** How many times in a row the model may call tools before it is stopped */
const maxSteps = 5;

/** The longest time a script of a skill may run, in milliseconds */
const scriptTimeLimit = 120_000;

/** The longest result of a script that the model gets, in characters */
const maxScriptText = 20_000;

/**
 * Mounts the chat panel
 *
 * @param container - The element to mount the panel into
 * @param stores - The stores of the application
 * @returns A callback that unmounts the panel
 */
export function mountAiChat(
  container: HTMLElement,
  {
    projectStore,
    dataStore: appDataStore,
    settingsStore,
    appStore,
  }: PluginStores,
): () => void {
  // with the tables computed by the chat, which the tools must find at once
  const dataStore = withComputedTables(appDataStore, projectStore);
  // aborted on unmount, which stops the requests to the model and the table reads
  const abortController = new AbortController();
  const { signal } = abortController;

  /** The conversation so far, without the system message; sent in full each time */
  const messages: ChatMessage[] = [];

  /** The changes made by the chat, one list per request, the newest last */
  const undoStack: Change[][] = [];

  const tables: TableKnowledge = { info: new Map(), remembered: new Map() };
  // tables are read one after the other, not all at once
  let readingQueue = Promise.resolve();

  // what Ollama said when it was last asked
  let connected = false;
  let installed: string[] = [];
  let unreachable = notRunningMessage;

  /**
   * The API keys of OpenAI and Anthropic, by service: typed in this session or
   * remembered in the browser. They are only sent to their own service, and
   * never shown or logged.
   */
  const keys = new Map<ProviderId, string>();
  for (const provider of providers) {
    const key = loadSetting(`key.${provider.id}`);
    if (key !== null) {
      keys.set(provider.id, key);
    }
  }
  /** What the last check of each service's key found, for the status line */
  const keyStatus = new Map<ProviderId, string>();
  /** The services whose key was accepted by the last check */
  const acceptedKeys = new Set<ProviderId>();
  /** The services for which the chat already said what a key means */
  const announcedKeys = new Set<ProviderId>();
  /** Whether the settings are shown although the key works */
  let settingsOpen = false;

  /** The personality of the assistant, which follows the theme */
  let persona = personaFor(settingsStore.getState().dark);
  /** The indicator shown in the chat while the model thinks */
  let thinking: { element: HTMLElement; stop: () => void } | null = null;

  /** About how much the answers cost since the panel was opened, in dollars */
  let sessionCost = 0;

  /** The messages sent so far, for the up and down arrows */
  const sent: string[] = [];
  /** Which sent message the text box shows; `sent.length` for the new text */
  let sentIndex = 0;
  /** The new text, kept while the arrows show sent messages */
  let draft = "";

  const providerSelect = document.createElement("select");
  providerSelect.title = "Service";
  providerSelect.style.cssText = controlStyle;
  for (const provider of providers) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = provider.name;
    providerSelect.append(option);
  }
  const savedProvider = loadSetting("provider");
  if (providers.some((provider) => provider.id === savedProvider)) {
    providerSelect.value = savedProvider ?? "";
  }
  const modelSelect = document.createElement("select");
  modelSelect.title = "Model";
  modelSelect.style.cssText = controlStyle;
  const downloadButton = makeButton("Download", () => void download());
  const serviceRow = document.createElement("div");
  serviceRow.style.cssText = "display: flex; flex-wrap: wrap; gap: 8px;";
  serviceRow.append(providerSelect, modelSelect, downloadButton);

  // small buttons, so that they fit in one row of a narrow panel
  const newChatButton = makeButton("New chat", newChat, smallButtonStyle);
  const contextButton = makeButton(
    "Show context",
    () =>
      show(
        "Context sent to the model",
        `${instructionsFor(currentProvider())}\n\n${contextFor(currentProvider())}`,
        "info",
        true,
      ),
    smallButtonStyle,
  );
  const helpButton = makeButton(
    "Help",
    () => show("Help", helpText),
    smallButtonStyle,
  );
  const undoButton = makeButton("Undo", undo, smallButtonStyle);
  const undoAllButton = makeButton("Undo all", undoAll, smallButtonStyle);
  const settingsButton = makeButton("⚙", toggleSettings, smallButtonStyle);
  settingsButton.title = "Settings";
  settingsButton.setAttribute("aria-label", "Settings");
  settingsButton.style.marginLeft = "auto";
  const topRow = document.createElement("div");
  topRow.style.cssText =
    "display: flex; flex-wrap: wrap; gap: 6px; align-items: center;";
  topRow.append(
    newChatButton,
    contextButton,
    helpButton,
    undoButton,
    undoAllButton,
    settingsButton,
  );

  // the short line shown instead of the settings, while the key works
  const summary = document.createElement("div");
  summary.style.cssText = quietTextStyle;

  // a password field, so that the key is not shown on the screen
  const keyInput = document.createElement("input");
  keyInput.type = "password";
  keyInput.autocomplete = "off";
  keyInput.spellcheck = false;
  keyInput.style.cssText = `${controlStyle}flex: 1; min-width: 12em;`;
  const keyLabel = document.createElement("label");
  keyLabel.style.cssText =
    "display: flex; flex: 1; gap: 6px; align-items: center;";
  keyLabel.append("API key", keyInput);
  const rememberBox = document.createElement("input");
  rememberBox.type = "checkbox";
  rememberBox.style.accentColor = "var(--primary)";
  const rememberLabel = document.createElement("label");
  rememberLabel.append(rememberBox, " Remember key on this computer");
  const forgetButton = makeButton("Forget key", forgetKey);
  const keyRow = document.createElement("div");
  keyRow.style.cssText =
    "display: flex; flex-wrap: wrap; gap: 8px; align-items: center;";
  keyRow.append(keyLabel, rememberLabel, forgetButton);

  /** Whether the rows of the tools are open, remembered by the browser */
  let showToolDetails = loadSetting("toolDetails") === "true";
  const toolDetailsBox = document.createElement("input");
  toolDetailsBox.type = "checkbox";
  toolDetailsBox.checked = showToolDetails;
  toolDetailsBox.style.accentColor = "var(--primary)";
  toolDetailsBox.addEventListener("change", () => {
    showToolDetails = toolDetailsBox.checked;
    saveSetting("toolDetails", showToolDetails ? "true" : null);
    updateToolRows();
  });
  const toolDetailsLabel = document.createElement("label");
  toolDetailsLabel.title =
    "Show the calls and the results of the tools, instead of one line each";
  toolDetailsLabel.append(toolDetailsBox, " Show tool details");

  const status = document.createElement("span");
  status.setAttribute("role", "status");
  status.style.cssText = "flex: 1;";
  const checkButton = makeButton(
    "Check again",
    () => void check(),
    smallButtonStyle,
  );
  const statusRow = document.createElement("div");
  statusRow.style.cssText = "display: flex; gap: 8px; align-items: center;";
  statusRow.append(status, checkButton);

  // the skills of the open project, and those added by hand, remembered by
  // the browser if the user wants
  const skillList = makeSkillList(
    { load: loadStoredSkills, save: storeSkill, remove: forgetStoredSkill },
    updateLayout,
    { signal },
  );
  /** The skills of the project whose scripts the user allowed, by project and name */
  const allowedScripts = new Set<string>();

  /** The download of the files of Python in progress, if any */
  let pythonDownload: DownloadProgress | undefined;
  /** Shows the download, in the row of the tool that waits for Python */
  let showPythonDownload: (() => void) | null = null;
  const pythonFiles = makePythonFiles((progress) => {
    pythonDownload = progress;
    showPythonDownload?.();
  });
  /**
   * Python, kept for the next runs of this chat, and where the code that it
   * runs comes from: code from elsewhere gets a new one
   */
  let pythonKernel: { kernel: PythonKernel; source: string } | null = null;

  /** Stops Python: the next Python code starts it again */
  function stopPython(): void {
    pythonKernel?.kernel.stop();
    pythonKernel = null;
  }

  const pythonFilesInfo = document.createElement("span");
  pythonFilesInfo.style.cssText = quietTextStyle;
  const forgetPythonButton = makeButton(
    "Forget Python files",
    () => void forgetPython(),
    smallButtonStyle,
  );
  forgetPythonButton.title =
    "Remove the files of Python that this browser keeps; they are downloaded again when Python is needed";
  const pythonRow = document.createElement("div");
  pythonRow.style.cssText =
    "display: flex; flex-wrap: wrap; gap: 8px; align-items: center;";
  pythonRow.append(pythonFilesInfo, forgetPythonButton);

  /** Shows how many files of Python this browser keeps */
  async function updatePythonFiles(): Promise<void> {
    const count = await countPythonFiles();
    pythonFilesInfo.textContent =
      count === 0
        ? "Python: no files downloaded"
        : `Python: ${count} files kept in this browser`;
    forgetPythonButton.disabled = count === 0;
  }

  /** Forgets the files of Python that this browser keeps */
  async function forgetPython(): Promise<void> {
    const count = await forgetPythonFiles();
    pythonFilesInfo.textContent = `Python: ${count} files forgotten; they are downloaded again when Python is needed`;
    forgetPythonButton.disabled = true;
  }
  /** The project and workspace whose skills were read last */
  let skillsRead: { instanceId: string; workspace: unknown } | null = null;

  /**
   * Reads the skills of the open project again when another project is
   * opened or another folder connected; a later read wins over an earlier one
   */
  function readProjectSkills(): void {
    const { source, instanceId } = projectStore.getState();
    const workspace = appStore.getState().workspace ?? null;
    if (
      skillsRead?.instanceId === instanceId &&
      skillsRead.workspace === workspace
    ) {
      return;
    }
    const read = { instanceId, workspace };
    skillsRead = read;
    loadProjectSkills(source, workspace, { signal }).then(
      (project) => {
        if (skillsRead === read) {
          skillList.setProjectSkills(project);
        }
      },
      (error: unknown) => {
        if (!signal.aborted && skillsRead === read) {
          skillList.setProjectSkills(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      },
    );
  }

  const settingsBox = document.createElement("div");
  settingsBox.style.cssText =
    "display: flex; flex-direction: column; gap: 8px;";
  settingsBox.append(
    serviceRow,
    keyRow,
    statusRow,
    toolDetailsLabel,
    skillList.element,
    pythonRow,
  );

  const history = document.createElement("div");
  history.style.cssText =
    "flex: 1; min-height: 100px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px;" +
    "padding: 8px; border: 1px solid var(--border); border-radius: 6px;";

  // one row above the text box, which scrolls sideways if it is too long
  const examplesRow = document.createElement("div");
  examplesRow.style.cssText =
    "display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px;";

  const input = document.createElement("textarea");
  input.rows = 3;
  input.placeholder =
    "Type a message... (Enter to send, Shift+Enter for a new line, ↑ ↓ for the messages sent before)";
  input.style.cssText = `${controlStyle}flex: 1; resize: none;`;
  const sendButton = makeButton("Send", () => void send());
  sendButton.style.cssText +=
    "background: var(--primary); color: var(--primary-foreground); border-color: var(--primary);";
  const bottomRow = document.createElement("div");
  bottomRow.style.cssText = "display: flex; gap: 8px;";
  bottomRow.append(input, sendButton);

  const footer = document.createElement("div");
  footer.style.cssText = `${quietTextStyle}font-size: 11px; text-align: right;`;
  const creditsLink = document.createElement("a");
  creditsLink.textContent = credits.text;
  creditsLink.href = credits.url;
  creditsLink.target = "_blank";
  creditsLink.rel = "noopener noreferrer";
  creditsLink.title = "View on GitHub";
  creditsLink.style.cssText = "color: inherit; text-decoration: none;";
  // underlined only under the pointer, so that it stays quiet
  creditsLink.addEventListener("mouseenter", () => {
    creditsLink.style.textDecoration = "underline";
  });
  creditsLink.addEventListener("mouseleave", () => {
    creditsLink.style.textDecoration = "none";
  });
  footer.append(creditsLink);

  // shown under a part of an answer that the user selects
  const quoteButton = makeButton("Quote", quoteSelection, smallButtonStyle);
  quoteButton.style.cssText +=
    "position: absolute; display: none; z-index: 2;" +
    "background: var(--primary); color: var(--primary-foreground); border-color: var(--primary);";
  // a click on the button would otherwise end the selection first
  quoteButton.addEventListener("mousedown", (event) => event.preventDefault());

  /**
   * Finds the useful columns of one table: groups (e.g. clusters), numbers and
   * gene matrices; the others are only counted
   */
  async function readTable(tableId: string, projectId: string): Promise<void> {
    try {
      const tableRef = dataStore.getState().tableDataRefs.get(tableId);
      if (tableRef === undefined) {
        throw new Error("the table is not loaded");
      }
      const data = await tableRef.promise;
      const rows = data.getSize();
      const tooBig = rows > maxRowsToRead;
      const used = findUsedColumns(projectStore.getState(), tableId);
      const useful: ColumnInfo[] = [];
      let other = 0;
      for (const { name, matrix, hidden } of await listColumns(data, {
        signal,
      })) {
        if (hidden || (tooBig && !used.has(name))) {
          other++;
          continue;
        }
        // each column on its own: if one cannot be read, the others still are
        try {
          const described = matrix
            ? await describeMatrix(data, name, { signal })
            : describeValues(await data.loadValues(name, { signal }));
          if (described === undefined) {
            other++;
          } else {
            useful.push({ name, ...described });
          }
        } catch {
          signal.throwIfAborted();
          other++;
        }
      }
      const computed =
        projectStore.getState().tables.find(({ id }) => id === tableId)
          ?.dataSource.type === computedTableType;
      saveTableInfo(tableId, projectId, {
        status: "ready",
        ...(computed
          ? {
              note: "computed by the chat; temporary: lost when the page is reloaded, unless kept with save_computed_table",
            }
          : {}),
        rows,
        tooBig,
        useful,
        other,
      });
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      saveTableInfo(tableId, projectId, {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Keeps what was read about a table, if the same project is still open */
  function saveTableInfo(
    tableId: string,
    projectId: string,
    info: TableInfo,
  ): void {
    if (projectStore.getState().instanceId !== projectId) {
      return;
    }
    tables.info.set(tableId, info);
    updateExamples();
  }

  /**
   * Starts reading the tables of labels and points that TissUUmaps has loaded
   * and that were not read yet; runs again whenever the data store changes,
   * since tables can finish loading later
   */
  function readTables(): void {
    for (const tableId of linkedTables(projectStore.getState(), tables)) {
      if (
        dataStore.getState().tableDataRefs.has(tableId) &&
        !tables.info.has(tableId)
      ) {
        tables.info.set(tableId, { status: "reading" });
        const projectId = projectStore.getState().instanceId;
        readingQueue = readingQueue.then(() => readTable(tableId, projectId));
      }
    }
  }

  /**
   * Reads the tables of changed labels and points again: in a very big table
   * only the columns used now are read, and the colors may use others now
   */
  function rereadTables(someChanges: Change[]): void {
    const project = projectStore.getState();
    for (const { kind, id } of someChanges) {
      if (kind !== "labels" && kind !== "points") {
        continue;
      }
      const object = findById(project, kind, id) as ItemsObject | undefined;
      for (const tableId of object === undefined
        ? []
        : objectTables(object, tables)) {
        if (tables.info.get(tableId)?.status !== "reading") {
          tables.info.delete(tableId);
        }
      }
    }
    readTables();
  }

  /**
   * Shows example requests above the text box, also while the user types; a
   * click sends one, and leaves the text being typed as it is
   */
  function updateExamples(): void {
    const examples = exampleRequests(projectStore.getState(), tables);
    examplesRow.replaceChildren(
      ...examples.map((text) => {
        const button = makeButton(
          text,
          () => void send(text),
          `${smallButtonStyle}flex: none; white-space: nowrap;`,
        );
        button.title = "Send this request";
        return button;
      }),
    );
    examplesRow.style.display = examples.length > 0 ? "flex" : "none";
  }

  /**
   * Adds the frame of a message to the history: a name, with the avatar for
   * the assistant, and an empty body
   */
  function addFrame(who: string, kind: MessageKind): HTMLElement {
    const message = document.createElement("div");
    message.dataset.who = who;
    message.style.cssText =
      "padding: 6px 8px; border: 1px solid; border-radius: 6px; white-space: pre-wrap;" +
      messageStyles[kind];
    const header = document.createElement("div");
    header.style.cssText =
      "display: flex; align-items: center; gap: 6px; font-weight: bold;";
    if (kind === "error") {
      // the red alone is too light on the light theme's error background
      header.style.color =
        "color-mix(in oklch, var(--destructive) 70%, var(--foreground))";
    }
    if (kind === "assistant") {
      header.append(makeAvatar(persona));
    }
    header.append(who);
    const body = document.createElement("div");
    message.append(header, body);
    addToHistory(message);
    return body;
  }

  /**
   * Adds a message at the end of the history, but above the indicator that
   * the model is thinking, which stays the last one while the model works
   */
  function addToHistory(message: HTMLElement): void {
    history.insertBefore(message, thinking?.element ?? null);
    history.scrollTop = history.scrollHeight;
  }

  /**
   * The rows of the tools and the scripts, which open and close with "Show
   * tool details", except those kept open
   */
  const toolRows: { details: HTMLDetailsElement; keepOpen: boolean }[] = [];

  /**
   * Shows a tool call as one folded row: an icon and the first line of the
   * result, e.g. "🌫 Done: opacity of cell_labels 1 → 0.5"; opened, the call
   * and the whole result. Failed calls are always open.
   *
   * @param name - The tool
   * @param shownCall - The call, as it reads
   * @param result - The result for the model
   */
  function showTool(name: string, shownCall: string, result: string): void {
    const failed = result.startsWith("Error");
    const message = document.createElement("div");
    message.dataset.who = "Tool";
    message.style.cssText =
      "padding: 4px 8px; border: 1px solid; border-radius: 6px;" +
      messageStyles.tool;
    const details = document.createElement("details");
    details.open = failed || showToolDetails;
    const line = document.createElement("summary");
    line.style.cssText =
      "cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    line.textContent = `${failed ? "⚠️" : (toolIcons[name] ?? "🔧")} ${firstLine(result)}`;
    line.title = line.textContent;
    const body = document.createElement("div");
    body.dataset.details = "true";
    body.style.cssText = "white-space: pre-wrap; margin-top: 4px;";
    body.textContent = `${shownCall}\n→ ${result}`;
    details.append(line, body);
    message.append(details);
    addToHistory(message);
    toolRows.push({ details, keepOpen: failed });
  }

  /** Opens or folds the rows of the tools, as "Show tool details" says */
  function updateToolRows(): void {
    for (const { details, keepOpen } of toolRows) {
      details.open = keepOpen || showToolDetails;
    }
  }

  /**
   * Adds a message to the history and returns a function that sets its text,
   * so that an answer can be shown while it arrives
   */
  function addMessage(
    who: string,
    kind: MessageKind = "info",
    markdown = false,
  ): (text: string) => void {
    const body = addFrame(who, kind);
    let shownText = "";
    if (kind === "assistant") {
      // a part of the answers can be quoted
      body.dataset.quotable = "true";
      // the answer as the model wrote it, e.g. with its Markdown
      const copyButton = makeCopyButton(() => shownText, "the answer");
      copyButton.style.marginLeft = "auto";
      body.previousElementSibling?.append(copyButton);
    }
    return (text) => {
      shownText = text;
      body.replaceChildren(markdown ? renderMarkdown(text) : text);
      history.scrollTop = history.scrollHeight;
    };
  }

  /**
   * Adds a message with its final text to the history; without a kind, it
   * follows from the name ("You", "Tool", "Note", "Error")
   */
  function show(
    who: string,
    text: string,
    kind?: MessageKind,
    markdown?: boolean,
  ): void {
    const kinds: Record<string, MessageKind> = {
      You: "user",
      Tool: "tool",
      Note: "note",
      Error: "error",
    };
    addMessage(who, kind ?? kinds[who] ?? "info", markdown)(text);
  }

  /** Shows that the model is thinking, at the end of the history */
  function startThinking(): void {
    stopThinking();
    const indicator = makeThinkingIndicator();
    const body = addFrame(persona.name, "assistant");
    body.append(indicator.element);
    thinking = {
      element: body.parentElement ?? body,
      stop: indicator.stop,
    };
  }

  /** Removes the indicator that the model is thinking, if it is shown */
  function stopThinking(): void {
    thinking?.stop();
    thinking?.element.remove();
    thinking = null;
  }

  /**
   * The text the user selected in one answer of the model, or "" if nothing
   * or something else is selected
   */
  function selectedAnswerText(): { text: string; range?: Range } {
    const selection = window.getSelection();
    if (
      selection === null ||
      selection.isCollapsed ||
      selection.rangeCount === 0
    ) {
      return { text: "" };
    }
    const range = selection.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const element = node instanceof Element ? node : node.parentElement;
    const answer = element?.closest("[data-quotable]");
    if (answer === null || answer === undefined || !history.contains(answer)) {
      return { text: "" };
    }
    return { text: selection.toString().trim(), range };
  }

  /** Shows "Quote" under the selected part of an answer, or hides it */
  function updateQuoteButton(): void {
    const { text, range } = selectedAnswerText();
    if (text === "" || range === undefined) {
      quoteButton.style.display = "none";
      return;
    }
    // not every browser engine can measure a selection (e.g. in tests)
    if (typeof range.getBoundingClientRect === "function") {
      const selected = range.getBoundingClientRect();
      const panel = container.getBoundingClientRect();
      quoteButton.style.left = `${Math.max(0, selected.left - panel.left)}px`;
      quoteButton.style.top = `${Math.max(0, selected.bottom - panel.top + 4)}px`;
    }
    quoteButton.style.display = "";
  }

  /** Puts the selected part of an answer as a quote into the text box */
  function quoteSelection(): void {
    const { text } = selectedAnswerText();
    if (text === "") {
      return;
    }
    const quote = text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    input.value = `${quote}\n\n${input.value}`;
    window.getSelection()?.removeAllRanges();
    quoteButton.style.display = "none";
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  /**
   * Up and down arrows in the text box: shows the messages sent before, like a
   * terminal. Only on the first or the last line of the text, so that in a
   * longer text the arrows still move between its lines.
   */
  function browseSent(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    const up = event.key === "ArrowUp";
    const { value, selectionStart, selectionEnd } = input;
    const onEdge = up
      ? !value.slice(0, selectionStart).includes("\n")
      : !value.slice(selectionEnd).includes("\n");
    const next = sentIndex + (up ? -1 : 1);
    if (!onEdge || next < 0 || next > sent.length) {
      return;
    }
    event.preventDefault();
    if (sentIndex === sent.length) {
      draft = value;
    }
    sentIndex = next;
    input.value = next === sent.length ? draft : (sent[next] ?? "");
    input.setSelectionRange(input.value.length, input.value.length);
  }

  /** Starts a new conversation, after asking; the undo list stays, since it is about the project */
  function newChat(): void {
    if (sendButton.disabled) {
      return;
    }
    const question =
      "Start a new chat? The model forgets this conversation. Undo still works for the changes made so far.";
    if (messages.length > 0 && !window.confirm(question)) {
      return;
    }
    messages.length = 0;
    history.replaceChildren();
    toolRows.length = 0;
    updateExamples();
    // a new chat gets a new Python
    stopPython();
  }

  /** Enables "Undo" and "Undo all" when there is something to undo and the model is not working */
  function updateUndoButtons(): void {
    const enabled = undoStack.length > 0 && !sendButton.disabled;
    for (const button of [undoButton, undoAllButton]) {
      button.disabled = !enabled;
      button.style.opacity = enabled ? "1" : "0.5";
    }
  }

  /**
   * Puts back the values from before one request, from its last change to
   * its first, and returns one line per change for the chat
   */
  function undoRequest(changes: Change[]): string[] {
    const lines: string[] = [];
    for (const change of [...changes].reverse()) {
      const now = currentValue(change, projectStore, appStore);
      if (now === undefined) {
        const kept =
          change.type === "computed" &&
          projectStore.getState().tables.some(({ id }) => id === change.id);
        lines.push(
          kept
            ? `${change.name} was kept as a CSV file, so it stays`
            : `${change.name} is not in the project any more, so it was skipped`,
        );
        continue;
      }
      takeBack(change, projectStore, appStore);
      // the changes of the maps are only named, e.g. "Chat colors – cell_labels"
      let line =
        isMapKind(change.kind) && change.type === undefined
          ? change.name
          : describeValueChange(change, now.value, change.before);
      if (!same(now.value, change.after)) {
        line += handNote;
      }
      lines.push(line);
    }
    forgetGoneComputedTables();
    rereadTables(changes);
    return [...new Set(lines)];
  }

  /**
   * Tells the model what was undone, so that it does not trust the old tool
   * results; as a "user" message, since not every model accepts a system
   * message in the middle of a conversation
   */
  function tellModel(text: string): void {
    messages.push({
      role: "user",
      text: `(Note from the chat panel, not typed by the user: ${text} The project summary shows the current state.)`,
    });
  }

  /** Takes back the changes of the last request */
  function undo(): void {
    const changes = undoStack.pop();
    if (changes === undefined) {
      return;
    }
    const lines = undoRequest(changes);
    show("Undo", `Undone: ${lines.join(", ")}`);
    tellModel(`the user clicked "Undo". Undone: ${lines.join(", ")}.`);
    updateUndoButtons();
  }

  /** Takes back all the changes made by the chat, after asking */
  function undoAll(): void {
    const question =
      "Undo all the changes made by the chat? Settings you changed by hand that the chat never touched stay as they are.";
    if (!window.confirm(question)) {
      return;
    }
    const touched = new Map<string, { change: Change; from: unknown }>();
    for (const change of undoStack.flat()) {
      const key = `${change.type ?? ""} ${change.kind} ${change.id} ${change.property}`;
      if (!touched.has(key)) {
        touched.set(key, {
          change,
          from: currentValue(change, projectStore, appStore)?.value,
        });
      }
    }
    const notes: string[] = [];
    for (
      let changes = undoStack.pop();
      changes !== undefined;
      changes = undoStack.pop()
    ) {
      for (const line of undoRequest(changes)) {
        if (line.endsWith(handNote) || line.endsWith("skipped")) {
          notes.push(line);
        }
      }
    }
    const restored: string[] = [];
    for (const { change, from } of touched.values()) {
      const to = currentValue(change, projectStore, appStore)?.value;
      if (change.type === "added") {
        restored.push(describeValueChange(change, from, to));
      } else if (
        from !== undefined &&
        !same(from, to) &&
        !isMapKind(change.kind)
      ) {
        restored.push(describeValueChange(change, from, to));
      }
    }
    let text = `Restored: ${restored.join(", ") || "nothing, the values were already as before"}.`;
    if (notes.length > 0) {
      text += `\nNotes: ${notes.join("; ")}.`;
    }
    show("Undo all", text);
    tellModel(
      `the user clicked "Undo all", which took back every change made by the chat. ${text}`,
    );
    updateUndoButtons();
  }

  /**
   * Keeps the examples up to date, and when another project is opened (it
   * gets a new instanceId), forgets the old project's tables and undo list
   * and asks whether to clear the conversation
   */
  function onProjectChange(
    state: ProjectStore,
    previousState: ProjectStore,
  ): void {
    const objectsChanged =
      state.images !== previousState.images ||
      state.labels !== previousState.labels ||
      state.points !== previousState.points;
    if (objectsChanged) {
      updateExamples();
    }
    if (state.instanceId === previousState.instanceId) {
      return;
    }
    // Python may hold data of the other project
    stopPython();
    // the computed tables of the other project, unless this one has them too
    forgetVersions(
      new Set(
        state.tables
          .filter(({ dataSource }) => dataSource.type === computedTableType)
          .map(({ dataSource }) => dataSource.source ?? ""),
      ),
    );
    tables.info.clear();
    tables.remembered.clear();
    readTables();
    updateExamples();
    if (undoStack.length > 0) {
      undoStack.length = 0;
      show(
        "Undo",
        "Another project was opened, so there is nothing to undo any more.",
      );
      updateUndoButtons();
    }
    if (messages.length === 0) {
      return;
    }
    show(
      "Chat",
      "Another project was opened. The earlier messages talk about objects of the old project.",
    );
    // asked a moment later, so that TissUUmaps can finish opening the project first
    setTimeout(() => {
      const question =
        "Another project was opened. Clear the conversation with the model, so that it starts fresh with the new project?";
      if (window.confirm(question)) {
        messages.length = 0;
        show(
          "Chat",
          "Conversation cleared: the model only knows about the new project now.",
        );
        updateExamples();
      } else {
        show(
          "Chat",
          "Conversation kept: the model still remembers the earlier messages.",
        );
      }
    }, 0);
  }

  /** Fills the model menu with the models of the chosen service */
  function fillModelMenu(): void {
    const provider = currentProvider();
    const chosen = loadSetting(`model.${provider.id}`) ?? modelSelect.value;
    const models = usesOllama(provider)
      ? ollamaModels(provider)
      : provider.models;
    modelSelect.replaceChildren();
    for (const { name, note } of models) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = `${name} (${note})`;
      modelSelect.append(option);
    }
    if (models.some(({ name }) => name === chosen)) {
      modelSelect.value = chosen;
    }
  }

  /**
   * The models of an Ollama service: the installed ones of that kind (local or
   * online) first, then the suggested ones
   */
  function ollamaModels(provider: Provider): { name: string; note: string }[] {
    const online = provider.id === "ollama-cloud";
    const names = [
      ...installed.filter((name) => name.endsWith("cloud") === online),
      ...provider.models.map(({ name }) => name),
    ];
    return [...new Set(names)].map((name) => {
      let note = connected ? "not downloaded" : "local";
      if (online) {
        note = "online";
      } else if (installed.includes(name)) {
        note = "local";
      }
      return { name, note };
    });
  }

  /** The service chosen in the menu */
  function currentProvider(): Provider {
    return providers.find(
      (provider) => provider.id === providerSelect.value,
    ) as Provider;
  }

  /**
   * Writes the status line, and shows the key field and "Download" only when
   * they are needed
   */
  function updateStatus(): void {
    const provider = currentProvider();
    const name = modelSelect.value;
    downloadButton.style.display = "none";
    keyRow.style.display = provider.needsKey ? "flex" : "none";
    if (provider.needsKey) {
      status.textContent =
        keyStatus.get(provider.id) ??
        (keys.has(provider.id)
          ? `${provider.name}: the key is not checked yet. Click "Check again".`
          : `${provider.name}: paste your API key below. No key yet? Click "Help".`);
    } else if (!connected) {
      status.textContent = unreachable;
    } else if (provider.id === "ollama-cloud") {
      status.textContent = `Ollama: connected. ${name} runs online: you need to be signed in (see Help).`;
    } else if (installed.includes(name)) {
      status.textContent = `Ollama: connected. ${name} is ready.`;
    } else {
      status.textContent = `Ollama: connected. ${name} is not downloaded yet.`;
      downloadButton.style.display = "";
    }
    updateLayout();
  }

  /**
   * Folds the settings into one short line while the key of the chosen
   * service works, unless the user opened them with ⚙
   */
  function updateLayout(): void {
    const provider = currentProvider();
    const accepted = acceptedKeys.has(provider.id);
    const folded = accepted && !settingsOpen;
    settingsBox.style.display = folded ? "none" : "flex";
    summary.style.display = folded ? "" : "none";
    const skills = skillList.activeSkills().length;
    summary.textContent = `${provider.name} · ${modelSelect.value} · key ✓${skills > 0 ? ` · ${skills} skill${skills === 1 ? "" : "s"}` : ""}`;
    settingsButton.style.display = accepted ? "" : "none";
    settingsButton.setAttribute("aria-expanded", String(!folded));
  }

  /** ⚙: shows or hides the settings */
  function toggleSettings(): void {
    settingsOpen = !settingsOpen;
    updateLayout();
  }

  /**
   * Something went wrong with OpenAI or Anthropic: the status line says what,
   * and the settings open, so that the key can be checked or changed
   */
  function showServiceProblem(provider: Provider, text: string): void {
    if (usesOllama(provider)) {
      return;
    }
    acceptedKeys.delete(provider.id);
    keyStatus.set(provider.id, text);
    settingsOpen = true;
    updateStatus();
  }

  /** Shows the key of the chosen service, and whether it is remembered */
  function showKey(): void {
    const provider = currentProvider();
    keyInput.value = keys.get(provider.id) ?? "";
    keyInput.placeholder = `Paste your ${provider.name} API key`;
    rememberBox.checked = loadSetting(`key.${provider.id}`) !== null;
  }

  /** Keeps the key as it is typed, and remembers it if the user wants */
  function onKeyInput(): void {
    const provider = currentProvider();
    const key = keyInput.value.trim();
    if (key === "") {
      keys.delete(provider.id);
    } else {
      keys.set(provider.id, key);
    }
    if (rememberBox.checked) {
      saveSetting(`key.${provider.id}`, key === "" ? null : key);
    }
    keyStatus.delete(provider.id);
    acceptedKeys.delete(provider.id);
    updateStatus();
  }

  /** Remembers the key in the browser, or forgets it there */
  function onRememberChange(): void {
    const provider = currentProvider();
    saveSetting(
      `key.${provider.id}`,
      rememberBox.checked ? (keys.get(provider.id) ?? null) : null,
    );
  }

  /** Forgets the key of the chosen service, also in the browser */
  function forgetKey(): void {
    const provider = currentProvider();
    keys.delete(provider.id);
    keyStatus.delete(provider.id);
    acceptedKeys.delete(provider.id);
    saveSetting(`key.${provider.id}`, null);
    keyInput.value = "";
    rememberBox.checked = false;
    updateStatus();
  }

  /**
   * Checks the key of the chosen service, with a request that costs nothing.
   * A working key folds the settings; the first time a pasted key works, the
   * chat also says what using it means.
   *
   * @param pasted - Whether the user has just pasted the key
   */
  async function checkKey(pasted = false): Promise<void> {
    const provider = currentProvider();
    const key = keys.get(provider.id);
    keyStatus.delete(provider.id);
    acceptedKeys.delete(provider.id);
    if (key === undefined || provider.checkKey === undefined) {
      updateStatus();
      return;
    }
    keyStatus.set(provider.id, `${provider.name}: checking the key...`);
    updateStatus();
    let error: string | undefined;
    try {
      error = await provider.checkKey(key, { signal });
    } catch {
      if (signal.aborted) {
        return;
      }
      error = notReachable(provider);
    }
    // the key may have been changed in the meantime
    if (keys.get(provider.id) !== key) {
      return;
    }
    if (error !== undefined) {
      showServiceProblem(provider, error);
      return;
    }
    const text = `${provider.name}: key accepted. Each request is billed to your ${provider.name} account, and your messages and the project summary are sent to ${provider.name}.`;
    keyStatus.set(provider.id, text);
    acceptedKeys.add(provider.id);
    settingsOpen = false;
    updateStatus();
    if (pasted && !announcedKeys.has(provider.id)) {
      announcedKeys.add(provider.id);
      show(provider.name, `${text} The key settings are under ⚙.`, "note");
    }
  }

  /** "Check again": asks Ollama for its models, or checks the key */
  async function check(): Promise<void> {
    await (usesOllama(currentProvider()) ? checkOllama() : checkKey());
  }

  /** Nothing answers at the Ollama address: finds out why, for the status line */
  async function lostOllama(): Promise<string> {
    connected = false;
    unreachable = await explainNotReachable({ signal });
    updateStatus();
    return unreachable;
  }

  /** Asks Ollama which models are installed */
  async function checkOllama(): Promise<void> {
    status.textContent = "Ollama: checking...";
    try {
      const response = await fetch(`${ollamaUrl}/api/tags`, { signal });
      const data = (await response.json()) as { models: { name: string }[] };
      installed = data.models.map((model) => model.name);
      connected = true;
    } catch {
      if (signal.aborted) {
        return;
      }
      connected = false;
      unreachable = await explainNotReachable({ signal });
    }
    fillModelMenu();
    updateStatus();
  }

  /** Downloads the chosen model, with the progress in the status line */
  async function download(): Promise<void> {
    const name = modelSelect.value;
    downloadButton.disabled = true;
    status.textContent = `Downloading ${name}...`;
    try {
      const response = await fetch(`${ollamaUrl}/api/pull`, {
        method: "POST",
        body: JSON.stringify({ model: name }),
        signal,
      });
      await readJsonLines<OllamaPullUpdate>(
        response,
        (update) => {
          if (update.error !== undefined) {
            throw new Error(update.error);
          }
          status.textContent =
            update.total === undefined
              ? `Downloading ${name}: ${update.status ?? ""}`
              : `Downloading ${name}: ${Math.round((100 * (update.completed ?? 0)) / update.total)}%`;
        },
        { signal },
      );
      downloadButton.disabled = false;
      await checkOllama();
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      downloadButton.disabled = false;
      // fetch fails with a TypeError when nothing answers
      if (error instanceof TypeError) {
        await lostOllama();
      } else {
        status.textContent = `Download failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  /**
   * The context of a new turn: the personality of now (a new theme changes
   * the tone at once) and the summary of the project as it is now
   *
   * It stays the same for all the requests of the turn, while the model calls
   * tools: OpenAI and Anthropic only take the model's thinking back while
   * everything before it is unchanged. The tool results tell the model what
   * changed during the turn.
   */
  async function turnContext(provider: Provider): Promise<string> {
    // the summary should show the current columns: wait for the table reads,
    // but not for more than 5 seconds
    await Promise.race([
      readingQueue,
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    return contextFor(provider);
  }

  /**
   * The instructions for a service: for the strong models, with the types of
   * the app state, which never change
   */
  function instructionsFor(provider: Provider): string {
    return provider.wholeApp
      ? `${instructions.replace(toolLimits, actionLimits)}\n\n${wholeAppInstructions}\n\n${skillInstructions}\n\n${codeInstructions}`
      : instructions;
  }

  /**
   * The tools for a service: for the strong models, also call_action, the
   * skills and run_code
   */
  function toolsFor(provider: Provider) {
    return [
      ...toolDefinitions,
      ...(provider.wholeApp
        ? [
            callActionDefinition,
            ...skillToolDefinitions,
            runCodeDefinition,
            saveComputedTableDefinition,
          ]
        : []),
    ].map((definition) => definition.function);
  }

  /**
   * The context as it is now: for the strong models, with the skills that
   * are on and the app state as JSON after the summary
   */
  function contextFor(provider: Provider): string {
    const summary = buildContext(
      projectStore.getState(),
      dataStore,
      tables,
      persona,
    );
    if (!provider.wholeApp) {
      return summary;
    }
    const skills = describeSkills(skillList.activeSkills());
    const state = stateJson(projectStore.getState(), appStore.getState());
    return `${summary}\n\n${skills}\n\n# The current app state, as JSON\n${state}`;
  }

  /**
   * Sends the instructions, the context of the turn, the conversation and the
   * tools to the model
   *
   * @param provider - The service
   * @param model - The model
   * @param key - The API key of the service, or ""
   * @param context - The context of the turn, see {@link turnContext}
   * @param onText - Called with the text so far, each time a piece arrives
   * @returns The answer, or an error message
   */
  async function askModel(
    provider: Provider,
    model: string,
    key: string,
    context: string,
    onText: (text: string) => void,
  ): Promise<ChatAnswer> {
    return provider.chat(
      {
        model,
        key,
        instructions: instructionsFor(provider),
        context,
        messages,
        tools: toolsFor(provider),
      },
      onText,
      { signal },
    );
  }

  /**
   * Shows under the last message of a turn, folded under "Usage", the tokens
   * of its requests, and for the services that bill them, about how much they
   * cost, also in total since the panel was opened
   */
  function showUsage(
    provider: Provider,
    model: string,
    usage: Usage,
    requests: number,
  ): void {
    const message = history.lastElementChild;
    if (requests === 0 || message === null) {
      return;
    }
    const count = (tokens: number) => tokens.toLocaleString("en-US");
    const parts = [`${count(usage.input)} input`];
    if (provider.needsKey) {
      parts.push(
        `${count(usage.cacheRead)} from cache`,
        `${count(usage.cacheWrite)} written to cache`,
      );
    }
    parts.push(`${count(usage.output)} output`);
    const prices = provider.models.find(({ name }) => name === model)?.prices;
    if (prices === undefined) {
      parts.push("free");
    } else {
      const cost =
        (usage.input * prices.input +
          usage.cacheRead * prices.cacheRead +
          usage.cacheWrite * prices.cacheWrite +
          usage.output * prices.output) /
        1_000_000;
      sessionCost += cost;
      parts.push(
        `≈ ${dollars(cost)}`,
        `this session ≈ ${dollars(sessionCost)}`,
      );
    }
    // folded, so that the chat is not crowded
    const usageBox = document.createElement("details");
    usageBox.style.cssText = "margin-top: 4px;";
    const toggle = document.createElement("summary");
    toggle.style.cssText = `${quietButtonStyle}width: fit-content;`;
    toggle.textContent = "Usage";
    toggle.title = "The tokens of this request, and about how much they cost";
    const line = document.createElement("div");
    line.dataset.usage = "true";
    line.style.cssText = `${quietTextStyle}font-size: 11px; margin-top: 2px;`;
    line.textContent = `Tokens${requests > 1 ? ` (${requests} requests)` : ""}: ${parts.join(" · ")}`;
    usageBox.append(toggle, line);
    message.append(usageBox);
  }

  /**
   * Answers a question of a script in the sandbox, always with copies, so
   * that the script cannot change the data of the project
   *
   * @param question - What the script asks for, through tm
   * @param skill - The skill of the script, for tm.readFile; none for the
   * code of the model
   * @param options - Optional abort signal, and the changes of the request,
   * for the columns that the script saves
   * @returns The answer
   * @throws If the question cannot be answered, e.g. an unknown table
   */
  async function answerScript(
    question: ScriptQuestion,
    skill: Skill | undefined,
    options?: { signal?: AbortSignal; changes?: Change[] },
  ): Promise<unknown> {
    const { signal: stop, changes } = options ?? {};
    stop?.throwIfAborted();
    if (question.kind === "save_column") {
      return saveComputedColumn(question, changes, { signal: stop });
    }
    if (question.kind === "tables") {
      return projectStore
        .getState()
        .tables.map(({ id, name }) => ({ id, name }));
    }
    if (question.kind === "file") {
      if (skill === undefined) {
        throw new Error(
          "only the scripts of skills have files to read, and this code is not part of a skill",
        );
      }
      const file = skill.files.get(question.path);
      if (file === undefined) {
        throw new Error(`the skill has no file "${question.path}"`);
      }
      return file.text();
    }
    const table = projectStore
      .getState()
      .tables.find(
        ({ id, name }) => id === question.table || name === question.table,
      );
    const tableRef =
      table === undefined
        ? undefined
        : dataStore.getState().tableDataRefs.get(table.id);
    if (table === undefined || tableRef === undefined) {
      throw new Error(
        `there is no loaded table "${question.table}"; tm.tables() lists the tables`,
      );
    }
    const data = await tableRef.promise;
    stop?.throwIfAborted();
    if (question.kind === "columns") {
      if (question.matrix !== undefined) {
        return matrixColumns(data, question.matrix, { signal: stop });
      }
      return (await listColumns(data, { signal: stop })).map(
        ({ name, matrix }) => ({ name, matrix }),
      );
    }
    const rows = data.getSize();
    if (rows > maxRowsToRead) {
      throw new Error(
        `the table "${table.name}" has ${rows} rows, too many to read here (at most ${maxRowsToRead})`,
      );
    }
    const values = await data.loadValues(question.column, { signal: stop });
    // a copy of these values only, not of a buffer they may share
    return values.slice();
  }

  /**
   * Saves a column that code computed, one value per row of a table, into the
   * table "(chat)" of that table: a new version of it, so that TissUUmaps reads
   * the values again, and a change that Undo takes back. The original table
   * is never changed.
   *
   * @param question - The table, the name of the column, the values, and the
   * item IDs of the values if they are not one per row
   * @param changes - The changes of the request
   * @param options - Optional abort signal
   * @returns What was saved, for the code
   * @throws If the column cannot be saved, with the reason for the code
   */
  async function saveComputedColumn(
    question: Extract<ScriptQuestion, { kind: "save_column" }>,
    changes: Change[] | undefined,
    options?: { signal?: AbortSignal },
  ): Promise<unknown> {
    const { signal: stop } = options ?? {};
    if (changes === undefined) {
      throw new Error("columns can only be saved while the chat runs code");
    }
    const project = projectStore.getState();
    const given = project.tables.find(
      ({ id, name }) => id === question.table || name === question.table,
    );
    if (given === undefined) {
      throw new Error(
        `there is no table "${question.table}"; tm.tables() lists the tables`,
      );
    }
    // a table computed by the chat stands for its original table
    const originId = versionOf(given.dataSource.source)?.originId ?? given.id;
    const origin = project.tables.find(({ id }) => id === originId);
    const column =
      typeof question.column === "string" ? question.column.trim() : "";
    if (
      column === "" ||
      column.length > 60 ||
      /[[\]\r\n]/.test(column) ||
      column.toLowerCase() === "id"
    ) {
      throw new Error(
        `${JSON.stringify(question.column)} cannot be the name of a column: give a short name, without [ ], other than "id"`,
      );
    }
    const tableRef = dataStore.getState().tableDataRefs.get(originId);
    if (origin === undefined || tableRef === undefined) {
      throw new Error(`the table "${question.table}" is not loaded`);
    }
    const data = await tableRef.promise;
    stop?.throwIfAborted();
    const rows = data.getSize();
    if (rows > maxRowsToRead) {
      throw new Error(
        `the table "${origin.name}" has ${rows} rows, too many for a computed column (at most ${maxRowsToRead})`,
      );
    }
    const values = columnValues(question.values);
    const byRow =
      typeof values === "string" || question.ids === undefined
        ? values
        : valuesByRow(data.getIds(), question.ids, values);
    if (typeof byRow === "string") {
      throw new Error(byRow);
    }
    if (byRow.length !== rows) {
      throw new Error(
        `the table "${origin.name}" has ${rows} rows, but there are ${byRow.length} values: give one value per row, in the order of tm.read, or give the ids of the values`,
      );
    }
    const tableId = `${computedTableType}:${originId}`;
    const existing = project.tables.find(({ id }) => id === tableId);
    if (
      existing !== undefined &&
      existing.dataSource.type !== computedTableType
    ) {
      throw new Error(
        `the table "${existing.name}" was kept as a CSV file, so the chat cannot add columns to it`,
      );
    }
    const previous = versionOf(existing?.dataSource.source);
    const saved = project.tables
      .filter(({ dataSource }) => dataSource.type === computedTableType)
      .reduce(
        (count, table) =>
          count + (versionOf(table.dataSource.source)?.columns.size ?? 0),
        0,
      );
    if (
      !(previous?.columns.has(column) ?? false) &&
      saved >= maxComputedColumns
    ) {
      throw new Error(
        `the tables computed by the chat have ${maxComputedColumns} columns already, the most there can be: tell the user, who can take some back with Undo`,
      );
    }
    const columns = new Map(previous?.columns);
    columns.set(column, byRow);
    const source = keepVersion({
      originId,
      ids: data.getIds(),
      names: data.getNames?.(),
      columns,
    });
    const name = existing?.name ?? `${origin.name} (chat)`;
    if (existing === undefined) {
      project.addTable(
        createTable({
          id: tableId,
          name,
          dataSource: { type: computedTableType, source },
        }),
      );
    } else {
      project.updateTable(tableId, {
        dataSource: { ...existing.dataSource, source },
      });
    }
    changes.push({
      type: "computed",
      kind: "tables",
      id: tableId,
      name,
      property: column,
      before: existing?.dataSource.source,
      after: source,
    });
    linkComputedTable(originId, tableId);
    showComputedColumn(tableId, name, column, byRow);
    return {
      table: name,
      column,
      rows,
      values: byRow instanceof Float64Array ? "numbers" : "text",
    };
  }

  /**
   * Lets the labels and points that use a table use its table "(chat)" too,
   * and has the panel read it again
   *
   * @param originId - The original table
   * @param tableId - The table computed by the chat
   */
  function linkComputedTable(originId: string, tableId: string): void {
    const project = projectStore.getState();
    for (const object of [...project.labels, ...project.points]) {
      if (objectTables(object, tables).includes(originId)) {
        const remembered = tables.remembered.get(object.id) ?? new Set();
        remembered.add(tableId);
        tables.remembered.set(object.id, remembered);
      }
    }
    tables.info.delete(tableId);
    readTables();
  }

  /** Forgets the tables computed by the chat that are not in the project any more */
  function forgetGoneComputedTables(): void {
    const ids = new Set(projectStore.getState().tables.map(({ id }) => id));
    for (const remembered of tables.remembered.values()) {
      for (const tableId of remembered) {
        if (tableId.startsWith(`${computedTableType}:`) && !ids.has(tableId)) {
          remembered.delete(tableId);
        }
      }
    }
  }

  /**
   * Shows in the chat that code saved a column, with buttons to keep its table
   * as a CSV file or to download it
   *
   * @param tableId - The table computed by the chat
   * @param tableName - Its name
   * @param column - The column
   * @param values - Its values
   */
  function showComputedColumn(
    tableId: string,
    tableName: string,
    column: string,
    values: ComputedValues,
  ): void {
    const body = addFrame("Table", "note");
    const what = describeValues(values)?.text ?? "the same value in every row";
    const line = document.createElement("div");
    line.textContent =
      `📊 New column ${column} in ${tableName} (${what}). It is temporary: ` +
      "it is lost when the page is reloaded, unless the table is kept as a CSV file.";
    const buttons = document.createElement("div");
    buttons.style.cssText = "display: flex; gap: 6px; margin-top: 4px;";
    const keep = makeButton(
      "Keep as CSV",
      () => {
        const target = keepTarget();
        const fileName = askCsvName(
          tableId,
          target === undefined
            ? `This project was not opened from a connected folder, so "${tableName}" is downloaded as a CSV file instead.`
            : `Save "${tableName}" as a CSV file in the folder "computed" next to the project file, in "${target.name}". Then the project reads the table from that file.`,
        );
        if (fileName !== undefined) {
          void keepComputedTable(tableId, { fileName, chosen: true }).then(
            reportKept,
          );
        }
      },
      smallButtonStyle,
    );
    keep.title =
      "Write the table as a CSV file next to the project file, in the connected folder";
    const download = makeButton(
      "Download CSV",
      () => {
        const fileName = askCsvName(
          tableId,
          `Download "${tableName}" as a CSV file.`,
        );
        if (fileName !== undefined) {
          reportKept(downloadComputedTable(tableId, fileName));
        }
      },
      smallButtonStyle,
    );
    download.title = "Download the table as a CSV file";
    buttons.append(keep, download);
    body.append(line, buttons);
  }

  /**
   * Shows what keeping or downloading a computed table did: only what went
   * wrong is an error, not e.g. a download instead, or the user's own choice
   */
  function reportKept(result: string): void {
    show(
      result.startsWith("Error") ? "Error" : "Note",
      result.replace(/^(Error|Done|Note): /, ""),
    );
  }

  /**
   * Asks the user for the name of the CSV file of a computed table, proposing
   * one with the table, its columns and the day, until the name is valid
   *
   * @param tableId - The table computed by the chat
   * @param action - What happens with the file
   * @returns The name, with ".csv", or undefined if the user cancelled
   */
  function askCsvName(tableId: string, action: string): string | undefined {
    const found = findComputedTable(tableId);
    if ("error" in found) {
      reportKept(found.error);
      return undefined;
    }
    let problem = "";
    let proposal = suggestCsvName(found.table.name, [
      ...found.version.columns.keys(),
    ]);
    for (;;) {
      const answer: unknown = window.prompt(
        `${problem}${action}\n\nFile name:`,
        proposal,
      );
      if (typeof answer !== "string") {
        return undefined;
      }
      const checked = csvFileName(answer);
      if ("name" in checked) {
        return checked.name;
      }
      problem = `${checked.error}.\n\n`;
      proposal = answer;
    }
  }

  /**
   * The connected folder that holds the project file, if the computed tables
   * can be written next to it
   *
   * @returns The folder, or undefined for a project opened from elsewhere
   */
  function keepTarget(): FileSystemDirectoryHandle | undefined {
    const workspace = appStore.getState().workspace ?? null;
    const projectSource = projectStore.getState().source;
    if (workspace === null || projectSource === null) {
      return undefined;
    }
    const where = SourceUtils.normalizeSource(
      "computed",
      workspace,
      projectSource,
    );
    return SourceUtils.isWorkspacePath(where) ? workspace : undefined;
  }

  /**
   * Finds a table computed by the chat, by its name or ID
   *
   * @param wanted - The name or ID
   * @returns The table and its values, or the error for the model
   */
  function findComputedTable(
    wanted: string,
  ):
    | { error: string }
    | { table: ProjectStore["tables"][number]; version: ComputedTable } {
    const table = projectStore
      .getState()
      .tables.find(({ id, name }) => id === wanted || name === wanted);
    const version = versionOf(table?.dataSource.source);
    if (table === undefined || table.dataSource.type !== computedTableType) {
      return {
        error: `Error: there is no temporary table computed by the chat called "${wanted}"${table === undefined ? "" : " (it was kept as a CSV file already)"}.`,
      };
    }
    if (version === undefined) {
      return {
        error: `Error: the values of "${table.name}" are gone: it was computed in an earlier session. Compute it again.`,
      };
    }
    return { table, version };
  }

  /**
   * Keeps a table computed by the chat as a CSV file next to the project file,
   * after asking the user; then the project reads it from that file, also
   * once saved and opened again, even without the chat
   *
   * @param wanted - The name or ID of the table
   * @param options - The name of the file, if given (else a useful one), and
   * whether the user chose it already, so that there is nothing more to ask
   * than whether to replace a file of that name
   * @returns The result for the model: "Done", "Note" when it was not kept
   * (e.g. by the user's choice), or "Error"
   */
  async function keepComputedTable(
    wanted: string,
    options?: { fileName?: string; chosen?: boolean },
  ): Promise<string> {
    const found = findComputedTable(wanted);
    if ("error" in found) {
      return found.error;
    }
    const { table, version } = found;
    const checked =
      options?.fileName === undefined
        ? { name: suggestCsvName(table.name, [...version.columns.keys()]) }
        : csvFileName(options.fileName);
    if ("error" in checked) {
      return `Error: ${checked.error}.`;
    }
    const fileName = checked.name;
    const workspace = keepTarget();
    if (workspace === undefined) {
      const downloaded = downloadComputedTable(table.id, fileName);
      return downloaded.startsWith("Error")
        ? downloaded
        : `Done: the project was not opened from a connected folder, so "${table.name}" cannot be written next to it; it was downloaded instead. ${downloaded.replace(/^Done: /, "")}`;
    }
    if (!idsSurviveCsv(version.ids)) {
      return `Note: "${table.name}" cannot be kept as a CSV file: its item IDs are text that looks like numbers, which a CSV file would turn into numbers, so the table would not match its items any more. It stays temporary; Download CSV still gives the file.`;
    }
    const allowed =
      options?.chosen === true ||
      window.confirm(
        `Save the table "${table.name}", computed by the chat, as the file computed/${fileName} next to the project file, in the folder "${workspace.name}"?\n\n` +
          "Then the project reads the table from that file, also after it is saved and opened again.",
      );
    if (!allowed) {
      return `Note: the user did not want "${table.name}" to be saved as a file. It stays temporary; do not ask again unless the user does.`;
    }
    const where = SourceUtils.normalizeSource(
      `computed/${fileName}`,
      workspace,
      projectStore.getState().source,
    );
    try {
      const folder = workspace as FileSystemDirectoryHandle & {
        requestPermission?: (options: {
          mode: "readwrite";
        }) => Promise<PermissionState>;
      };
      if (
        folder.requestPermission !== undefined &&
        (await folder.requestPermission({ mode: "readwrite" })) !== "granted"
      ) {
        return `Note: the browser was not allowed to write into the folder "${workspace.name}", so "${table.name}" stays temporary.`;
      }
      const segments = SourceUtils.getPathSegments(where);
      let directory: FileSystemDirectoryHandle = workspace;
      for (const [index, segment] of segments.slice(0, -1).entries()) {
        directory = await directory.getDirectoryHandle(segment, {
          // only the folder "computed" is made
          create: index === segments.length - 2,
        });
      }
      const exists = await directory.getFileHandle(fileName).then(
        () => true,
        () => false,
      );
      if (
        exists &&
        !window.confirm(
          `The folder "computed" next to the project file already has a file ${fileName}. Replace it with "${table.name}"?`,
        )
      ) {
        return `Note: "${table.name}" was not saved: the file computed/${fileName} already exists, and the user did not want to replace it. It stays temporary; another file name would do.`;
      }
      const file = await directory.getFileHandle(fileName, { create: true });
      const writable = await file.createWritable();
      await writable.write(computedTableCsv(version));
      await writable.close();
    } catch (error) {
      return `Error: "${table.name}" could not be written: ${error instanceof Error ? error.message : String(error)}. It stays temporary.`;
    }
    projectStore.getState().updateTable(table.id, {
      dataSource: {
        type: "csv",
        source: `computed/${fileName}`,
        idColumn: "id",
      } as TableDataSource,
    });
    tables.info.delete(table.id);
    readTables();
    return `Done: "${table.name}" was saved as computed/${fileName} next to the project file, and the project now reads it from there. Save the project to keep this; the table is not temporary any more, and Undo does not take it back.`;
  }

  /**
   * Downloads a table computed by the chat as a CSV file, with the item IDs
   * in the column "id"
   *
   * @param wanted - The name or ID of the table
   * @param given - The name of the file, else a useful one
   * @returns The result for the model
   */
  function downloadComputedTable(wanted: string, given?: string): string {
    const found = findComputedTable(wanted);
    if ("error" in found) {
      return found.error;
    }
    const { table, version } = found;
    const checked =
      given === undefined
        ? { name: suggestCsvName(table.name, [...version.columns.keys()]) }
        : csvFileName(given);
    if ("error" in checked) {
      return `Error: ${checked.error}.`;
    }
    const fileName = checked.name;
    const url = URL.createObjectURL(
      new Blob([computedTableCsv(version)], { type: "text/csv" }),
    );
    const link = document.createElement("a");
    link.download = fileName;
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return `Done: "${table.name}" was downloaded as ${fileName}, with the item IDs in the column "id". In TissUUmaps the table stays temporary.`;
  }

  /**
   * Shows a script or the code of the model in the chat before it runs, as
   * one row like those of the tools, e.g. "📜 counter/scripts/count.js",
   * whose code opens with a click
   *
   * @param name - The name of the row, e.g. "📜 counter/scripts/count.js"
   * @param tooltip - What the row is, when the pointer is on it
   * @param code - The code
   * @returns Opens the code and keeps it open, e.g. while the user is asked
   * whether the script may run
   */
  function showScript(name: string, tooltip: string, code: string): () => void {
    const message = document.createElement("div");
    message.dataset.who = "Script";
    message.style.cssText =
      "padding: 4px 8px; border: 1px solid; border-radius: 6px;" +
      messageStyles.tool;
    const details = document.createElement("details");
    details.open = showToolDetails;
    const line = document.createElement("summary");
    line.style.cssText =
      "cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    line.textContent = name;
    line.title = tooltip;
    const pre = document.createElement("pre");
    pre.dataset.details = "true";
    pre.textContent = code;
    pre.style.cssText =
      "margin: 0; max-height: 240px; overflow: auto; white-space: pre;" +
      "font-family: monospace; font-size: 12px;";
    const copyButton = makeCopyButton(() => code, "the code");
    copyButton.style.alignSelf = "flex-end";
    const body = document.createElement("div");
    body.style.cssText =
      "display: flex; flex-direction: column; margin-top: 4px;";
    body.append(copyButton, pre);
    details.append(line, body);
    message.append(details);
    addToHistory(message);
    const row = { details, keepOpen: false };
    toolRows.push(row);
    return () => {
      row.keepOpen = true;
      details.open = true;
      history.scrollTop = history.scrollHeight;
    };
  }

  /**
   * Runs a script of a skill in the sandbox: shows its code, asks the user
   * the first time for a skill that came with the project, and shows how
   * long it has been running
   *
   * @param skill - The skill
   * @param path - The path of the script in the skill
   * @param args - What the script gets as tm.args
   * @param options - Optional abort signal, which stops the script, and
   * where to show the progress
   * @returns The result for the model
   * @throws If the script takes too long, or is stopped
   */
  async function runSkillScript(
    skill: Skill,
    path: string,
    args: unknown,
    options?: RunOptions,
  ): Promise<string> {
    const { signal: stop } = options ?? {};
    stop?.throwIfAborted();
    const code = (await skill.files.get(path)?.text()) ?? "";
    stop?.throwIfAborted();
    const openCode = showScript(
      `📜 ${skill.name}/${path}`,
      `${path}, a JavaScript script of the skill "${skill.name}": click to read its code`,
      code,
    );
    const from = skillList.projectSourceOf(skill);
    const key = `${projectStore.getState().instanceId}:${skill.name}`;
    if (from !== undefined && !allowedScripts.has(key)) {
      // the user must be able to read the code before saying yes
      openCode();
      // time to show the code before the question, which blocks the page
      await new Promise((resolve) => setTimeout(resolve, 100));
      const allowed = window.confirm(
        `The skill "${skill.name}" came with the open project (from ${from}). Run its script ${path}?\n\n` +
          "Its code is shown in the chat. Scripts run in a sandbox: they can read the data of the project, " +
          "but cannot change it, use the network or see your API key. You are asked once for each skill of the project.",
      );
      if (!allowed) {
        return `Error: the user did not allow the scripts of the skill "${skill.name}", which came with the project. Tell the user, and do not run them again unless they ask.`;
      }
      allowedScripts.add(key);
    }
    return runInSandbox(
      code,
      args,
      skill,
      { short: path, full: `${path} of the skill "${skill.name}"` },
      options,
    );
  }

  /**
   * Runs code that the model wrote in the sandbox, after showing it
   *
   * @param title - What the code computes, in the words of the model
   * @param code - The code
   * @param language - JavaScript, or Python
   * @param options - Optional abort signal, which stops the code, and where
   * to show the progress
   * @returns The result for the model
   * @throws If the code takes too long, or is stopped
   */
  async function runCode(
    title: string,
    code: string,
    language: "javascript" | "python",
    options?: RunOptions,
  ): Promise<string> {
    options?.signal?.throwIfAborted();
    const python = language === "python";
    showScript(
      `📜 ${persona.name}'s code: ${title}${python ? " (Python)" : ""}`,
      `${python ? "Python" : "JavaScript"} that ${persona.name} wrote: click to read it`,
      code,
    );
    const names = { short: "the code", full: `the code "${title}"` };
    return python
      ? runInPython(code, {}, undefined, names, "chat", options)
      : runInSandbox(code, {}, undefined, names, options);
  }

  /**
   * The result of a script or of the code of the model, for the model
   *
   * @param outcome - What the sandbox gave back
   * @param name - The code, for the model (e.g. 'the code "cells per cluster"')
   * @param started - When the code started to run, in milliseconds
   * @returns The text, cut if it is too long
   */
  function scriptResult(
    outcome: ScriptOutcome,
    name: string,
    started: number,
  ): string {
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const logs =
      outcome.logs.length > 0 ? `\n\nLog:\n${outcome.logs.join("\n")}` : "";
    const text =
      outcome.error !== undefined
        ? `Error: ${name} failed: ${outcome.error}${logs}`
        : `Done: ran ${name} in ${seconds} s.\n\nResult:\n${outcome.result || "(nothing)"}${logs}`;
    return text.length > maxScriptText
      ? `${text.slice(0, maxScriptText)}\n\n(Cut: only the first ${maxScriptText} of ${text.length} characters.)`
      : text;
  }

  /**
   * Runs Python code: starts Python first if needed, which may download its
   * files, and loads the packages that the code imports. Neither counts for
   * the time limit.
   *
   * @param code - The code, with a function main(tm)
   * @param args - What the code gets as tm.args
   * @param skill - The skill of a script, for tm.read_file
   * @param names - The code in the progress row, and for the model
   * @param source - Where the code comes from, e.g. "chat": code from
   * elsewhere gets a new Python, so that it cannot change what the code
   * from here uses
   * @param options - Optional abort signal, which stops the code, and where
   * to show the progress
   * @returns The result for the model
   * @throws If the code takes too long, or is stopped
   */
  async function runInPython(
    code: string,
    args: unknown,
    skill: Skill | undefined,
    names: { short: string; full: string },
    source: string,
    options?: RunOptions,
  ): Promise<string> {
    const { signal: stop, progress, changes } = options ?? {};
    let step = "starting Python";
    let started: number | undefined;
    let reported = "";
    // e.g. "0.4" or "12"
    const megabytes = (bytes: number) =>
      bytes < 10e6 ? (bytes / 1e6).toFixed(1) : Math.round(bytes / 1e6);
    const update = () =>
      progress?.(
        pythonDownload !== undefined
          ? `Downloading Python, ${megabytes(pythonDownload.done)} of ${megabytes(pythonDownload.total)} MB`
          : started === undefined
            ? step
            : `running ${names.short}, ${Math.round((Date.now() - started) / 1000)} s${reported === "" ? "" : `: ${reported}`}`,
      );
    showPythonDownload = update;
    update();
    const ticker = setInterval(update, 1000);
    try {
      if (
        pythonKernel === null ||
        pythonKernel.kernel.isStopped() ||
        pythonKernel.source !== source
      ) {
        stopPython();
        pythonKernel = {
          kernel: await startPythonKernel(pythonFiles, { signal: stop }),
          source,
        };
      }
      step = "loading the Python packages";
      update();
      const outcome = await pythonKernel.kernel.run(
        {
          code,
          args,
          project: JSON.parse(
            stateJson(projectStore.getState(), appStore.getState()),
          ) as unknown,
        },
        (question) => answerScript(question, skill, { signal: stop, changes }),
        {
          timeLimit: scriptTimeLimit,
          signal: stop,
          onProgress: (text) => {
            reported = text;
            update();
          },
          onRunning: () => {
            started = Date.now();
            update();
          },
        },
      );
      return scriptResult(outcome, names.full, started ?? Date.now());
    } finally {
      clearInterval(ticker);
      showPythonDownload = null;
      void updatePythonFiles();
    }
  }

  /**
   * Runs a script or the code of the model in the sandbox, and shows how
   * long it has been running
   *
   * @param code - The code: a module whose default export is a function of tm
   * @param args - What the code gets as tm.args
   * @param skill - The skill of a script, for tm.readFile
   * @param names - The code in the progress row (e.g. "scripts/count.js"),
   * and for the model (e.g. 'scripts/count.js of the skill "counter"')
   * @param options - Optional abort signal, which stops the code, and where
   * to show the progress
   * @returns The result for the model
   * @throws If the code takes too long, or is stopped
   */
  async function runInSandbox(
    code: string,
    args: unknown,
    skill: Skill | undefined,
    names: { short: string; full: string },
    options?: RunOptions,
  ): Promise<string> {
    const { signal: stop, progress, changes } = options ?? {};
    const started = Date.now();
    let reported = "";
    const update = () =>
      progress?.(
        `running ${names.short}, ${Math.round((Date.now() - started) / 1000)} s${reported === "" ? "" : `: ${reported}`}`,
      );
    update();
    const ticker = setInterval(update, 1000);
    try {
      const outcome = await runScript(
        {
          code,
          args,
          project: JSON.parse(
            stateJson(projectStore.getState(), appStore.getState()),
          ) as unknown,
        },
        (question) => answerScript(question, skill, { signal: stop, changes }),
        {
          timeLimit: scriptTimeLimit,
          signal: stop,
          onProgress: (text) => {
            reported = text;
            update();
          },
        },
      );
      return scriptResult(outcome, names.full, started);
    } finally {
      clearInterval(ticker);
    }
  }

  /**
   * Runs one tool call of the model
   *
   * A long tool shows its progress in a row of the chat, with a button that
   * stops it.
   *
   * @param shownCall - The call as the Tool row shows it
   * @returns The result for the model, and a warning for the user if another
   * visible object can cover the change
   */
  async function runTool(
    provider: Provider,
    name: string,
    args: ToolArguments,
    changes: Change[],
    shownCall: string,
  ): Promise<{ result: string; warning: string }> {
    const offered = !wholeAppTools.includes(name) || provider.wholeApp;
    const tool =
      Object.hasOwn(tools, name) && offered ? tools[name] : undefined;
    if (tool === undefined) {
      return {
        result: `Error: there is no tool called "${name}".`,
        warning: "",
      };
    }
    const changesBefore = changes.length;
    // stopped by its Stop button, or when the panel closes
    const stopper = new AbortController();
    const stopWithPanel = () => stopper.abort();
    signal.addEventListener("abort", stopWithPanel, { once: true });
    let progressRow: { frame: HTMLElement; line: HTMLElement } | null = null;
    const progress = (text: string) => {
      if (progressRow === null) {
        const body = addFrame("Tool", "tool");
        const line = document.createElement("div");
        const stopButton = makeButton(
          "Stop",
          () => stopper.abort(),
          `${smallButtonStyle}margin-top: 4px;`,
        );
        stopButton.title = "Stop this tool";
        body.append(line, stopButton);
        progressRow = { frame: body.parentElement ?? body, line };
      }
      progressRow.line.textContent = `${shownCall}\n… ${text}`;
    };
    let result: string;
    try {
      result = await tool(
        args,
        {
          projectStore,
          dataStore,
          appStore,
          tables,
          changes,
          skills: skillList.activeSkills(),
          progress,
          runSkillScript,
          runCode,
          keepComputedTable,
        },
        { signal: stopper.signal },
      );
    } catch (error) {
      signal.throwIfAborted();
      result = stopper.signal.aborted
        ? "Stopped by the user before the end. Tell the user, and do not run it again unless they ask."
        : `Error: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      signal.removeEventListener("abort", stopWithPanel);
      (progressRow as { frame: HTMLElement } | null)?.frame.remove();
    }
    const newChanges = changes.slice(changesBefore);
    rereadTables(newChanges);
    const warning = overlapWarning(projectStore.getState(), newChanges);
    if (warning !== "") {
      // the model is told right after "Done", which small models notice best
      result = result.replace(
        /^Done:? ?/,
        `Done. Tell the user: ${warning} What changed: `,
      );
    }
    return { result, warning };
  }

  /**
   * Sends a request to the model, and runs the tools it calls
   *
   * @param example - A suggested request to send; without it, the text in the
   * text box
   */
  async function send(example?: string): Promise<void> {
    const text = (example ?? input.value).trim();
    if (text === "" || sendButton.disabled) {
      return;
    }
    // the service, model and key of this request, even if the menus change
    // while the model works
    const provider = currentProvider();
    const model = modelSelect.value;
    const key = keys.get(provider.id) ?? "";
    if (provider.needsKey && key === "") {
      show(
        "Error",
        `Paste your ${provider.name} API key into the "API key" field first. No key yet? Click "Help".`,
      );
      return;
    }
    if (example === undefined) {
      input.value = "";
    }
    // for the up and down arrows
    if (sent.at(-1) !== text) {
      sent.push(text);
    }
    sentIndex = sent.length;
    show("You", text);
    // to forget this turn if it fails
    const start = messages.length;
    messages.push({ role: "user", text });
    updateExamples();
    sendButton.disabled = true;
    sendButton.textContent = "Waiting...";
    updateUndoButtons();
    const failedCalls: string[] = [];
    const changes: Change[] = [];
    const projectAtStart = projectStore.getState().instanceId;
    // the tokens of all the requests of this turn
    const usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    let requests = 0;
    // shown for the whole turn, below the messages, until the final answer
    startThinking();
    try {
      // the same for every step of this turn
      const context = await turnContext(provider);
      for (let step = 1; step <= maxSteps; step++) {
        // the answer is shown while it arrives, in a message made when the
        // first piece of text comes
        let setText: ((text: string) => void) | null = null;
        const answer: ChatAnswer = await askModel(
          provider,
          model,
          key,
          context,
          (textSoFar) => {
            setText ??= addMessage(persona.name, "assistant", true);
            setText(textSoFar);
          },
        );
        if ("error" in answer) {
          show("Error", answer.error);
          showServiceProblem(provider, answer.error);
          messages.length = start;
          break;
        }
        messages.push(answer.message);
        requests++;
        for (const kind of [
          "input",
          "cacheRead",
          "cacheWrite",
          "output",
        ] as const) {
          usage[kind] += answer.message.usage?.[kind] ?? 0;
        }
        const toolCalls = answer.message.toolCalls;
        if (toolCalls.length === 0) {
          // small models sometimes answer with an empty text
          if (setText === null) {
            show(persona.name, "(no text answer)", "assistant", true);
          }
          break;
        }
        let repeated = false;
        for (const call of toolCalls) {
          const { name, arguments: args } = call;
          const callText = describeCall(name, args);
          // an action is shown as it reads, with names instead of IDs
          const shownCall =
            name === "call_action"
              ? describeAction(projectStore.getState(), args)
              : name === "run_code"
                ? // the code itself has its own row, just above
                  describeCall(name, {
                    title: args["title"],
                    ...(args["language"] === undefined
                      ? {}
                      : { language: args["language"] }),
                  })
                : callText;
          let outcome = {
            result: "Error: this exact call already failed.",
            warning: "",
          };
          if (failedCalls.includes(callText)) {
            repeated = true;
          } else {
            outcome = await runTool(provider, name, args, changes, shownCall);
          }
          if (outcome.result.startsWith("Error")) {
            failedCalls.push(callText);
          }
          showTool(name, shownCall, outcome.result);
          if (outcome.warning !== "") {
            show("Note", outcome.warning);
          }
          messages.push({
            role: "tool",
            callId: call.id,
            name,
            result: outcome.result,
          });
        }
        if (repeated) {
          show(
            "Error",
            "Stopped: the model repeated a tool call that had already failed.",
          );
          break;
        }
        if (step === maxSteps) {
          show(
            "Error",
            `Stopped after ${maxSteps} steps without a final answer.`,
          );
        }
      }
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      messages.length = start;
      if (usesOllama(provider)) {
        // fetch fails when nothing answers: Ollama is not running, or blocks the page
        show("Error", await lostOllama());
      } else {
        // fetch fails with a TypeError when nothing answers
        const message =
          error instanceof TypeError
            ? notReachable(provider)
            : `Something went wrong: ${hideKey(error instanceof Error ? error.message : String(error), key)}`;
        show("Error", message);
        showServiceProblem(provider, message);
      }
    }
    stopThinking();
    showUsage(provider, model, usage, requests);
    // kept even if something failed later on, but not if another project
    // was opened in the meantime
    if (
      changes.length > 0 &&
      projectStore.getState().instanceId === projectAtStart
    ) {
      undoStack.push(changes);
    }
    sendButton.disabled = false;
    sendButton.textContent = "Send";
    updateUndoButtons();
  }

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      browseSent(event);
    }
  });
  providerSelect.addEventListener("change", () => {
    const provider = currentProvider();
    saveSetting("provider", provider.id);
    settingsOpen = false;
    showKey();
    fillModelMenu();
    updateStatus();
    if (usesOllama(provider)) {
      void checkOllama();
    } else if (!keyStatus.has(provider.id)) {
      void checkKey();
    }
  });
  modelSelect.addEventListener("change", () => {
    saveSetting(`model.${currentProvider().id}`, modelSelect.value);
    updateStatus();
  });
  keyInput.addEventListener("input", onKeyInput);
  // when the key is pasted or typed and the field is left
  keyInput.addEventListener("change", () => void checkKey(true));
  rememberBox.addEventListener("change", onRememberChange);
  // the selection changes on the whole page, and the answers can scroll
  document.addEventListener("selectionchange", updateQuoteButton);
  history.addEventListener("scroll", updateQuoteButton);
  // a new theme gives the assistant another personality
  const unsubscribeSettings = settingsStore.subscribe((state) => {
    persona = personaFor(state.dark);
  });

  container.style.cssText =
    "display: flex; flex-direction: column; gap: 8px; height: 100%;" +
    "position: relative; color: var(--foreground);";
  container.append(
    topRow,
    summary,
    settingsBox,
    history,
    examplesRow,
    bottomRow,
    footer,
    quoteButton,
  );

  // the container is attached to the panel only after mount, and its parent
  // has to fill the panel for "height: 100%" to work
  const observer = new ResizeObserver(() => {
    if (container.parentElement !== null) {
      container.parentElement.style.height = "100%";
    }
  });
  observer.observe(container);

  // TissUUmaps loads the tables computed by the chat from memory
  registerComputedTables(appStore);
  const unsubscribeData = dataStore.subscribe(readTables);
  const unsubscribeProject = projectStore.subscribe(onProjectChange);
  const unsubscribeProjectSkills = projectStore.subscribe(readProjectSkills);
  const unsubscribeWorkspace = appStore.subscribe(readProjectSkills);
  readTables();
  readProjectSkills();
  showKey();
  fillModelMenu();
  updateStatus();
  void check();
  void updatePythonFiles();
  updateUndoButtons();
  updateExamples();

  return () => {
    abortController.abort();
    stopPython();
    stopThinking();
    observer.disconnect();
    unsubscribeData();
    unsubscribeProject();
    unsubscribeProjectSkills();
    unsubscribeWorkspace();
    unsubscribeSettings();
    document.removeEventListener("selectionchange", updateQuoteButton);
  };
}
