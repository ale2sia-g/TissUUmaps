import type { SkillStorage, StoredSkill } from "./skill-storage";
import { type FolderFile, type Skill, readSkills } from "./skills";
import { makeButton, quietTextStyle, smallButtonStyle } from "./ui";

/** A skill in the list of the panel */
type SkillEntry = {
  skill: Skill;
  /** Whether the skill is on, so that the model can use it */
  enabled: boolean;
  /** Whether the browser remembers it for the next sessions */
  remembered: boolean;
};

/** The section of the settings with the skills */
export type SkillList = {
  /** The section */
  element: HTMLElement;
  /**
   * The skills that are on
   *
   * @returns The skills, by name
   */
  activeSkills: () => Skill[];
};

/** The look of the checkboxes */
const checkboxStyle = "accent-color: var(--primary);";

/**
 * The files of a skill, as the browser remembers them
 *
 * @param entry - The skill in the list
 * @returns The skill to remember
 */
function toStored({ skill, enabled }: SkillEntry): StoredSkill {
  return {
    name: skill.name,
    enabled,
    files: [
      { path: `${skill.name}/SKILL.md`, content: new Blob([skill.skillMd]) },
      ...[...skill.files].map(([path, content]) => ({
        path: `${skill.name}/${path}`,
        content,
      })),
    ],
  };
}

/**
 * Creates a checkbox with its label
 *
 * @param text - The label
 * @param checked - Whether it is checked
 * @param onChange - What a change does, with the new state
 * @returns The label, with the checkbox inside
 */
function makeCheckbox(
  text: string,
  checked: boolean,
  onChange: (checked: boolean) => void,
): HTMLLabelElement {
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = checked;
  box.style.cssText = checkboxStyle;
  box.addEventListener("change", () => onChange(box.checked));
  const label = document.createElement("label");
  label.style.cssText = "display: flex; gap: 4px; align-items: center;";
  label.append(box, text);
  return label;
}

/**
 * Creates the section of the settings with the skills: "Add skill…" reads a
 * chosen folder, with one skill or a folder of skills; each skill can be
 * turned off and on, remembered by the browser or not, and removed
 *
 * @param storage - Where the skills added by hand are remembered
 * @param onChange - Called when the skills that are on change
 * @param options - Optional abort signal, for the reads
 * @returns The section, and the skills that are on
 */
export function makeSkillList(
  storage: SkillStorage,
  onChange: () => void,
  options?: { signal?: AbortSignal },
): SkillList {
  const { signal } = options ?? {};
  const entries: SkillEntry[] = [];

  const title = document.createElement("strong");
  title.textContent = "Skills";
  const folderInput = document.createElement("input");
  folderInput.type = "file";
  folderInput.webkitdirectory = true;
  folderInput.style.display = "none";
  const addButton = makeButton(
    "Add skill…",
    () => folderInput.click(),
    smallButtonStyle,
  );
  addButton.title =
    "Choose the folder of a skill (with its SKILL.md), or a folder of skills";
  const rememberLabel = makeCheckbox("Remember this skill", true, () => {});
  rememberLabel.title =
    "Keep the skill in this browser for the next sessions, in every project";
  const rememberBox = rememberLabel.querySelector("input")!;
  const header = document.createElement("div");
  header.style.cssText =
    "display: flex; flex-wrap: wrap; gap: 8px; align-items: center;";
  header.append(title, addButton, rememberLabel, folderInput);

  const list = document.createElement("div");
  list.style.cssText = "display: flex; flex-direction: column; gap: 6px;";
  const status = document.createElement("div");
  status.setAttribute("role", "status");
  status.style.cssText = quietTextStyle;

  const element = document.createElement("div");
  element.style.cssText = "display: flex; flex-direction: column; gap: 6px;";
  element.append(header, list, status);

  /**
   * Runs a task started by the user or by the panel, without waiting for it;
   * a task stopped because the panel closed is not an error
   *
   * @param task - The task
   */
  function runSafely(task: Promise<unknown>): void {
    task.catch((error: unknown) => {
      if (!signal?.aborted) {
        console.error(error);
      }
    });
  }

  /**
   * Says what happened, under the list
   *
   * @param lines - What happened, one line each
   */
  function report(lines: string[]): void {
    status.textContent = lines.join("\n");
    status.style.whiteSpace = "pre-line";
  }

  /**
   * Remembers or forgets a skill in the browser; a skill that cannot be
   * remembered stays for this session only
   *
   * @param entry - The skill
   * @returns What went wrong, or "" if nothing
   */
  async function store(entry: SkillEntry): Promise<string> {
    try {
      if (entry.remembered) {
        await storage.save(toStored(entry), { signal });
      } else {
        await storage.remove(entry.skill.name, { signal });
      }
      return "";
    } catch (error) {
      signal?.throwIfAborted();
      const reason = (error as Error).message;
      if (!entry.remembered) {
        return `The browser could not forget ${entry.skill.name}: ${reason}`;
      }
      entry.remembered = false;
      return `${entry.skill.name} is kept for this session only: ${reason}`;
    }
  }

  /** Shows the list of skills again */
  function render(): void {
    list.replaceChildren(
      ...entries.map((entry) => {
        const { skill } = entry;
        const enabledLabel = makeCheckbox(skill.name, entry.enabled, (on) => {
          entry.enabled = on;
          render();
          onChange();
          if (entry.remembered) {
            runSafely(
              store(entry).then((problem) => problem && report([problem])),
            );
          }
        });
        enabledLabel.title = entry.enabled
          ? "On: the assistant can use this skill"
          : "Off: the assistant does not see this skill";
        enabledLabel.style.fontWeight = "600";
        const rememberedLabel = makeCheckbox(
          "Remember",
          entry.remembered,
          (on) => {
            entry.remembered = on;
            runSafely(
              store(entry).then((problem) => {
                report([
                  problem ||
                    (on
                      ? `${skill.name} is remembered by this browser.`
                      : `${skill.name} is kept for this session only.`),
                ]);
                render();
              }),
            );
          },
        );
        rememberedLabel.style.cssText += quietTextStyle;
        rememberedLabel.title =
          "Keep the skill in this browser for the next sessions, in every project";
        const removeButton = makeButton(
          "Remove",
          () => {
            entries.splice(entries.indexOf(entry), 1);
            render();
            onChange();
            report([`${skill.name} removed.`]);
            if (entry.remembered) {
              entry.remembered = false;
              runSafely(
                store(entry).then((problem) => problem && report([problem])),
              );
            }
          },
          smallButtonStyle,
        );
        removeButton.setAttribute("aria-label", `Remove ${skill.name}`);
        const top = document.createElement("div");
        top.style.cssText =
          "display: flex; flex-wrap: wrap; gap: 8px; align-items: center;";
        top.append(enabledLabel, rememberedLabel, removeButton);

        const description = document.createElement("div");
        description.textContent = skill.description;
        description.title = skill.description;
        description.style.cssText = `${quietTextStyle}overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`;
        const row = document.createElement("div");
        row.style.cssText = `display: flex; flex-direction: column; gap: 2px; opacity: ${entry.enabled ? 1 : 0.6};`;
        row.append(top, description);
        for (const warning of skill.warnings) {
          const line = document.createElement("div");
          line.textContent = `${skill.name}: ${warning}`;
          line.style.cssText = quietTextStyle;
          row.append(line);
        }
        return row;
      }),
    );
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.textContent =
        "No skills yet. A skill is a folder with a SKILL.md file: instructions, and maybe scripts, for the assistant.";
      empty.style.cssText = quietTextStyle;
      list.append(empty);
    }
  }

  /**
   * Puts skills in the list, in place of those with the same name
   *
   * @param added - The skills, with their state
   * @returns The names of the skills that were replaced
   */
  function put(added: SkillEntry[]): string[] {
    const replaced: string[] = [];
    for (const entry of added) {
      const index = entries.findIndex(
        (other) => other.skill.name === entry.skill.name,
      );
      if (index === -1) {
        entries.push(entry);
      } else {
        entries[index] = entry;
        replaced.push(entry.skill.name);
      }
    }
    entries.sort((a, b) => a.skill.name.localeCompare(b.skill.name));
    return replaced;
  }

  /** Reads the skills of the folder chosen with "Add skill…" */
  async function addChosenFolder(): Promise<void> {
    const files: FolderFile[] = Array.from(folderInput.files ?? [], (file) => ({
      // the path from the chosen folder, which is part of it
      path: file.webkitRelativePath || file.name,
      content: file,
    }));
    // the same folder can be chosen again, e.g. after changing it
    folderInput.value = "";
    if (files.length === 0) {
      return;
    }
    const { skills, problems } = await readSkills(files, { signal });
    const added = skills.map((skill) => ({
      skill,
      enabled: true,
      remembered: rememberBox.checked,
    }));
    const replaced = put(added);
    render();
    onChange();
    const lines: string[] = [];
    if (added.length > 0) {
      const names = added.map(({ skill }) => skill.name).join(", ");
      lines.push(
        replaced.length > 0
          ? `Added: ${names} (replacing the one with the same name).`
          : `Added: ${names}.`,
      );
    }
    for (const { folder, error } of problems) {
      lines.push(`Not added: ${folder || "the chosen folder"}: ${error}.`);
    }
    if (added.length === 0 && problems.length === 0) {
      lines.push(
        "No skill found: a skill is a folder with a SKILL.md file in it.",
      );
    }
    report(lines);
    // a skill added for this session only replaces a remembered one, also
    // in the browser
    for (const entry of added) {
      const problem = await store(entry);
      if (problem !== "") {
        lines.push(problem);
        report(lines);
        render();
      }
    }
  }

  /** Puts the skills the browser remembers in the list */
  async function loadRemembered(): Promise<void> {
    const lines: string[] = [];
    try {
      const stored = await storage.load({ signal });
      const loaded: SkillEntry[] = [];
      for (const { name, enabled, files } of stored) {
        const { skills, problems } = await readSkills(files, { signal });
        loaded.push(
          ...skills.map((skill) => ({ skill, enabled, remembered: true })),
        );
        for (const { error } of problems) {
          lines.push(`The remembered skill ${name} cannot be read: ${error}.`);
        }
      }
      // skills added while these were read are kept
      put(
        loaded.filter(
          ({ skill }) =>
            !entries.some((other) => other.skill.name === skill.name),
        ),
      );
    } catch (error) {
      signal?.throwIfAborted();
      lines.push(
        `The remembered skills cannot be read: ${(error as Error).message}.`,
      );
    }
    render();
    onChange();
    if (lines.length > 0) {
      report(lines);
    }
  }

  folderInput.addEventListener("change", () => runSafely(addChosenFolder()));
  render();
  runSafely(loadRemembered());

  return {
    element,
    activeSkills: () =>
      entries.filter(({ enabled }) => enabled).map(({ skill }) => skill),
  };
}
