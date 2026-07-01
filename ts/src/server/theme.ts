// The theme lives in exactly one place: theme/theme.css at the repository
// root. Bun inlines this import as a string, so the compiled server binary is
// fully self-contained — the TypeScript equivalent of Go's //go:embed.
import css from "../../../theme/theme.css" with { type: "text" }

export const themeCss: string = css
