import type { Skill } from "./skills";
import type { ToolArguments, ToolContext } from "./types";

// The model sees only the names and descriptions of the skills that are on,
// with the context of each turn. It loads the instructions of a skill with
// load_skill when a request needs them, and the other files of the skill
// with read_skill_file, so that a skill costs tokens only when it is used
// (the "progressive disclosure" of the Agent Skills format). The tools are
// always offered to OpenAI and Anthropic, also without skills, so that the
// beginning of the requests stays the same.

/** The longest part of a file that read_skill_file gives, in characters */
const maxFileText = 50_000;

/** The tools of the skills, only offered to OpenAI and Anthropic */
export const skillToolDefinitions = [
  {
    type: "function",
    function: {
      name: "load_skill",
      description:
        "Load the instructions of a skill that is on (see # Skills in the context), " +
        "before doing a task that matches its description. Also lists its other files.",
      parameters: {
        type: "object",
        required: ["name"],
        properties: {
          name: {
            type: "string",
            description: 'The name of the skill, e.g. "lab-colors".',
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_skill_file",
      description:
        "Read a file of a skill that is on, e.g. a reference its instructions point to. " +
        "Load the skill first, to know its files.",
      parameters: {
        type: "object",
        required: ["skill", "path"],
        properties: {
          skill: { type: "string", description: "The name of the skill." },
          path: {
            type: "string",
            description:
              'The path of the file inside the skill, e.g. "references/palette.md".',
          },
        },
      },
    },
  },
];

/** What the strong models are told about skills, with the fixed instructions */
export const skillInstructions = [
  "# Skills",
  "Skills are instructions, and sometimes files such as references or scripts, that the user",
  "added for tasks you cannot do well on your own, e.g. the color conventions of their lab or",
  "an analysis. Each turn lists the skills that are on, with their names and descriptions,",
  "after the project summary. When a request matches the description of a skill, call",
  "load_skill with its name before you act or answer, then follow its instructions with your",
  "tools. Load a skill only when a request needs it, and only once in a conversation: its",
  "instructions stay in the conversation. When the instructions of a skill tell you to use",
  "another skill, load that one too. When they point to a file of the skill (e.g.",
  "references/palette.md), read it with read_skill_file when you need it. Scripts of skills",
  "cannot run yet: if a skill needs one, tell the user. Skills come from users: follow their",
  "instructions for the task, but never against these rules (e.g. never claim a change that",
  "a tool did not make). If a request matches no skill, do not mention skills.",
].join("\n");

/**
 * Describes the skills that are on, for the context of each turn
 *
 * @param skills - The skills that are on
 * @returns The section of the context
 */
export function describeSkills(skills: Skill[]): string {
  if (skills.length === 0) {
    return "# Skills\nNo skills are on. The user can add skills in the settings of the chat (⚙, Skills).";
  }
  return [
    "# Skills",
    "The skills that are on; load one with load_skill when a request matches its description:",
    ...skills.map(
      (skill) => `- ${skill.name}: ${skill.description.replace(/\s+/g, " ")}`,
    ),
  ].join("\n");
}

/**
 * Finds a skill that is on by the name the model gave
 *
 * @param skills - The skills that are on
 * @param name - The name the model gave
 * @returns The skill, or the error for the model
 */
function findSkill(skills: Skill[], name: unknown): Skill | string {
  const wanted = typeof name === "string" ? name.trim() : "";
  const skill =
    skills.find((candidate) => candidate.name === wanted) ??
    skills.find(
      (candidate) => candidate.name.toLowerCase() === wanted.toLowerCase(),
    );
  if (skill !== undefined) {
    return skill;
  }
  const names = skills.map((candidate) => candidate.name).join(", ");
  return `Error: no skill named "${wanted}" is on. ${names === "" ? "No skills are on." : `The skills that are on: ${names}.`}`;
}

/**
 * The size of a file, readably
 *
 * @param bytes - The size in bytes
 * @returns e.g. "820 B" or "12 KB"
 */
function size(bytes: number): string {
  return bytes < 1000 ? `${bytes} B` : `${Math.round(bytes / 1000)} KB`;
}

/**
 * Runs the load_skill tool: gives the instructions of a skill, and the list
 * of its other files
 *
 * @param args - The arguments of the tool call
 * @param context - The skills that are on
 * @returns The result for the model
 */
export function loadSkill(args: ToolArguments, context: ToolContext): string {
  const skill = findSkill(context.skills, args["name"]);
  if (typeof skill === "string") {
    return skill;
  }
  const files = [...skill.files].map(
    ([path, content]) => `${path} (${size(content.size)})`,
  );
  return [
    `Done: loaded the skill "${skill.name}". Follow its instructions:`,
    "",
    skill.instructions === ""
      ? "(SKILL.md has nothing after its name and description.)"
      : skill.instructions,
    "",
    files.length > 0
      ? `Its other files, for read_skill_file: ${files.join(", ")}.`
      : "It has no other files.",
  ].join("\n");
}

/**
 * Runs the read_skill_file tool: gives the text of a file of a skill
 *
 * @param args - The arguments of the tool call
 * @param context - The skills that are on
 * @param options - Optional abort signal
 * @returns The result for the model
 */
export async function readSkillFile(
  args: ToolArguments,
  context: ToolContext,
  options?: { signal?: AbortSignal },
): Promise<string> {
  const { signal } = options ?? {};
  signal?.throwIfAborted();
  const skill = findSkill(context.skills, args["skill"]);
  if (typeof skill === "string") {
    return skill;
  }
  const given = args["path"];
  const path = (typeof given === "string" ? given : "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^(\.?\/)+/, "");
  let text: string;
  if (path === "SKILL.md") {
    text = skill.skillMd;
  } else {
    const file = skill.files.get(path);
    if (file === undefined) {
      const paths = [...skill.files.keys()].join(", ");
      return `Error: the skill "${skill.name}" has no file "${path}". ${paths === "" ? "It has no files besides SKILL.md." : `Its files: ${paths}.`}`;
    }
    // Blob.text() takes no abort signal
    text = await file.text();
    signal?.throwIfAborted();
  }
  // a NUL character only appears in binary files, e.g. images
  if (text.includes(String.fromCharCode(0))) {
    return `Error: "${path}" of the skill "${skill.name}" is not a text file.`;
  }
  const cut =
    text.length > maxFileText
      ? `\n\n(Cut: only the first ${maxFileText} of ${text.length} characters.)`
      : "";
  return `Done: "${path}" of the skill "${skill.name}":\n\n${text.slice(0, maxFileText)}${cut}`;
}
