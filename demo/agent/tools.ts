/**
 * The agent's one real tool: recall.
 *
 * No scripted corpus. `recall` searches the agent's own Triolima memory — the
 * deep archive of everything the watchers have kept this conversation — so when
 * the person refers back to something, the model fetches it instead of guessing.
 * It is executed by the loop (which holds the memory), and it produces genuine
 * tool_call / tool_result hops in the trace.
 */
import type { ToolSpec } from './provider';

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'recall',
    description:
      'Search your own persistent memory for anything the person said earlier that is not in the MEMORY block. Returns the most relevant stored facts.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'what to look for' } }, required: ['query'], additionalProperties: false },
    strict: true,
  },
];
