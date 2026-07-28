const {
  runCompanySignalMonitor,
  runCompanyProfileCurator,
  runCompanyDiscovery,
  runEvidenceAuditor,
  runOpportunityInvestigator,
  runRelationshipPathfinder,
  runFollowUpStrategist,
  runLeadMomentumTracker,
  runReplyDetector,
  runInvestmentThesisResearcher,
  runSourcingFitScorer,
  runCalendarCrossReference,
  runGmailLeadScout,
  runOutcomeLearning,
  runAgentPortfolioManager,
  runIntelligenceCycle,
  runMasterOrchestrator,
} = require('./intelligence-agents');

// The single allowlist of manually-triggerable agents, shared by the control-tower "run now"
// route and the MCP connector's run_agent tool — one place to add or remove a runnable agent.
const COMPANY_SCOPED = ['opportunity-investigator', 'sourcing-fit-scorer'];

function buildRunners(params = {}) {
  return {
    'company-signal-monitor': () => runCompanySignalMonitor(Number(params.limit || 6)),
    'company-profile-curator': () => runCompanyProfileCurator(Number(params.limit || 4)),
    'company-discovery': () => runCompanyDiscovery(Number(params.limit || 6)),
    'evidence-auditor': () => runEvidenceAuditor(Number(params.limit || 30)),
    'opportunity-investigator': () => runOpportunityInvestigator(Number(params.company_id)),
    'relationship-pathfinder': () => runRelationshipPathfinder(Number(params.limit || 8)),
    'follow-up-strategist': () => runFollowUpStrategist(Number(params.limit || 12)),
    'lead-momentum-tracker': () => runLeadMomentumTracker(Number(params.limit || 20)),
    'reply-detector': () => runReplyDetector(Number(params.limit || 25)),
    'investment-thesis-researcher': () => runInvestmentThesisResearcher(Number(params.limit || 4)),
    'sourcing-fit-scorer': () => runSourcingFitScorer(Number(params.company_id)),
    'calendar-cross-reference': () => runCalendarCrossReference(Number(params.days || 7)),
    'gmail-lead-scout': () => runGmailLeadScout(Number(params.days || 3), Number(params.limit || 40)),
    'outcome-learning': () => runOutcomeLearning(),
    'agent-portfolio-manager': () => runAgentPortfolioManager(),
    'intelligence-cycle': () => runIntelligenceCycle(),
    'agent-orchestrator': () => runMasterOrchestrator(),
  };
}

module.exports = { buildRunners, COMPANY_SCOPED };
