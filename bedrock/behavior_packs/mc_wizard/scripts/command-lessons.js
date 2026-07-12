export const COMMAND_LESSONS = Object.freeze({
  hello: Object.freeze({
    id: "hello",
    title: "Hello command block",
    command: "/say Hello, builders!",
    explanation: "An impulse command block runs the command once when you press its button.",
    structureId: "mcwizard:command_hello",
  }),
  give_self: Object.freeze({
    id: "give_self",
    title: "Give yourself torches",
    command: "/give @p[r=5] minecraft:torch 16",
    explanation: "@p[r=5] selects only the nearest player within five blocks. Command blocks cannot use @s to mean the player who pressed their button.",
    structureId: "mcwizard:command_give_self",
  }),
});

export function commandLesson(id) {
  return COMMAND_LESSONS[id] || null;
}

export function commandLessonPrompt() {
  return Object.values(COMMAND_LESSONS)
    .map((lesson) => `${lesson.id}: ${lesson.title}; safe command ${lesson.command}`)
    .join(" | ");
}
