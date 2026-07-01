// The house stylesheet is embedded so the compiled binary is self-contained.
// theme.css is the single source of truth for the look of every themed page;
// this points at the canonical file at the repository root.
import css from "../../../theme/theme.css" with { type: "text" }

export const CSS: string = css
