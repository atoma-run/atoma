/** Only these tools are confined to workspace bytes and create no processes.
 * Everything else, including unknown future tools and apparently read-only HTTP,
 * may have an external effect. Never infer safety by parsing a shell command.
 */
export function checkpointToolIsRestorable(name: string): boolean {
  return ['read_file', 'write_file', 'edit_file', 'list_files'].includes(name);
}
