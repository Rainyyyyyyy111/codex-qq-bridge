'use strict';

// Three paragraphs fit in the existing final-answer envelope, including separators.
const writingLimits = {lead:480, assignment:350, passage:480, opening:480, section:480, evidence:350, conclusion:480};
function manuscript(lead, passage, conclusion) {
  return [lead, passage, conclusion].join('\n\n');
}
function checkConclusion(lead, passage, result) {
  for (const [source, edited, quote] of [[lead,result.opening,result.leadQuote],[passage,result.section,result.passageQuote]]) {
    if (!quote?.trim() || !source.includes(quote) || !edited.includes(quote) || !result.conclusion.includes(quote))
      throw Error('The joint conclusion must use a quotation from each authored section');
  }
  if (lead.includes(result.conclusion.trim()) || passage.includes(result.conclusion.trim()))
    throw Error('The joint conclusion must add to the two sections');
}
module.exports = {writingLimits, manuscript, checkConclusion};
