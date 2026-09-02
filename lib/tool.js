import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'audit-capability-tool'
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
 * A single stable bridge. Dynamic Audit extensions live behind this tool,
 * so adding one never changes the earlier system prompt or top-level catalog.
 * Audit findings are intentionally unavailable here. The service injects only
 * a bounded remediation prompt after explicit human acceptance.
 */
export function apply (ctx) {
  ctx.tools.register(defineTool({
    name: 'audit_capability',
    description: 'List or invoke dynamically installed Audit capabilities. This bridge never exposes audit feedback or reviewer state.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'invoke'] },
      capability: { type: 'string' },
      input: { type: 'object', additionalProperties: true }
    },
    output: OUTPUT,
    async execute (args, execution) {
      const audits = ctx.get('audits')
      const capabilities = audits?.capabilityNames?.() ?? []
      if (args.action === 'list') return { capabilities }
      if (typeof args.capability !== 'string' || args.capability === '') throw new Error('capability is required for invoke')
      return {
        capabilities,
        result: await audits.invokeCapability(args.capability, args.input, execution)
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Audit capability', kind: 'other', rawInput: args })
  }))
}
