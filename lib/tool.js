import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'guardian-capability-tool'
export const inject = ['tools']

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      capabilities: { type: 'array', items: { type: 'string' }, required: true },
      result: { type: 'json' }
    }
  },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
}

/**
 * A single stable bridge. Dynamic Guardian extensions live behind this tool,
 * so adding one never changes the earlier system prompt or top-level catalog.
 * Audit findings are intentionally unavailable here: they remain UI-only.
 */
export function apply (ctx) {
  ctx.tools.register(defineTool({
    name: 'guardian_capability',
    description: 'List or invoke dynamically installed Guardian capabilities. This bridge never exposes Guardian audit feedback or reviewer state.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'invoke'] },
      capability: { type: 'string' },
      input: { type: 'object', additionalProperties: true }
    },
    output: OUTPUT,
    async execute (args, execution) {
      const guardians = ctx.get('guardians')
      const capabilities = guardians?.capabilityNames?.() ?? []
      if (args.action === 'list') return { capabilities }
      if (typeof args.capability !== 'string' || args.capability === '') throw new Error('capability is required for invoke')
      return {
        capabilities,
        result: await guardians.invokeCapability(args.capability, args.input, execution)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Guardian capability', kind: 'other', rawInput: args })
  }))
}
