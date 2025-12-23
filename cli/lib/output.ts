import pc from "picocolors";

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function printHeader(text: string): void {
  console.log(pc.bold(pc.cyan(`\n=== ${text} ===\n`)));
}

export function printField(label: string, value: string | number | boolean | undefined): void {
  if (value !== undefined) {
    console.log(`${pc.dim(label + ":")} ${value}`);
  }
}

export function printListItem(text: string, indent = 0): void {
  const prefix = "  ".repeat(indent);
  console.log(`${prefix}${pc.yellow("•")} ${text}`);
}

export function printError(message: string): void {
  console.error(pc.red(`Error: ${message}`));
}

export function printSuccess(message: string): void {
  console.log(pc.green(`✓ ${message}`));
}

export function printWarning(message: string): void {
  console.log(pc.yellow(`⚠ ${message}`));
}

