import { RED_FLAG_KINDS } from '../config.js';
import type { AgentResult, Evidence, Factor, Finding, Phase2Rubric } from '../contracts.js';

export function aggregate(agents: AgentResult[], evidence: Evidence[], rubric: Phase2Rubric) {
  const completed = new Set(agents.filter((agent) => agent.status === 'completed').map((agent) => agent.source));
  const analysed = evidence.filter((item) => completed.has(item.source));
  const findings = agents.flatMap((agent) => agent.findings);
  const reviews = analysed.filter((item) => item.source === 'review').length;
  const news = analysed.filter((item) => item.source === 'news').length;
  const confidence = Number((rubric.reviewWeight * Math.min(reviews / rubric.fullReviewCount, 1) +
    rubric.newsWeight * Math.min(news / rubric.fullNewsCount, 1)).toFixed(4));
  const factors: Factor[] = [];
  if (analysed.length) factors.push({ name: 'Neutral baseline', points: rubric.baseline, evidenceIds: [] });
  const positive = findings.filter((finding) => finding.kind === 'positive_review');
  const negative = findings.filter((finding) => finding.kind === 'negative_review');
  if (positive.length || negative.length) factors.push({
    name: 'Review sentiment',
    points: positive.length > negative.length ? rubric.positiveReview : negative.length > positive.length ? rubric.negativeReview : 0,
    evidenceIds: [...new Set([...positive, ...negative].map((finding) => finding.evidenceId))],
  });
  const growth = findings.filter((finding) => finding.kind === 'growth');
  if (growth.length) factors.push({ name: 'Reported growth events',
    points: Math.min(rubric.maxGrowth, rubric.growth * growth.length),
    evidenceIds: growth.map((finding) => finding.evidenceId) });
  const redFlags = findings.filter((finding) => RED_FLAG_KINDS.some((kind) => kind === finding.kind));
  const penalised = redFlags.filter((finding) => rubric.penalisedKinds.some((kind) => kind === finding.kind));
  // At most one adverse penalty per article, even when it describes several flag types.
  for (const evidenceId of new Set(penalised.map((finding) => finding.evidenceId))) {
    factors.push({ name: 'Adverse news finding', points: rubric.redFlag, evidenceIds: [evidenceId] });
  }
  const dataGaps: string[] = [];
  if (reviews < rubric.fullReviewCount) dataGaps.push(`Only ${reviews} analysed reviews; request more dated customer reviews.`);
  if (news < rubric.fullNewsCount) dataGaps.push(`Only ${news} analysed news items; request relevant public business notices.`);
  const failedSources = agents.filter((agent) => agent.status === 'failed').map((agent) => agent.source);
  for (const source of failedSources) dataGaps.push(`${source} analysis failed; retry before relying on full coverage.`);
  return {
    score: analysed.length ? Math.max(0, Math.min(100, factors.reduce((sum, factor) => sum + factor.points, 0))) : null,
    confidence,
    coverage: { reviews, news, failedSources },
    factors, findings, redFlags, dataGaps,
  };
}
