// Launch document parser

import type { ParsedItem, ParsedLaunchDoc } from '../types';

export function parseLaunchDocument(content: string): ParsedLaunchDoc {
  const lines = content.split('\n');
  const phases: string[] = [];
  const items: ParsedItem[] = [];
  
  let currentPhase = '';
  let currentSection = '';
  let sortOrder = 0;
  
  for (const line of lines) {
    // Match phase headers: # PHASE 1: SETUP or # SETUP
    const phaseMatch = line.match(/^#\s+(?:PHASE\s*\d*:?\s*)?(.+)$/i);
    if (phaseMatch && !line.startsWith('##')) {
      currentPhase = phaseMatch[1].trim();
      if (!phases.includes(currentPhase)) {
        phases.push(currentPhase);
      }
      currentSection = '';
      continue;
    }
    
    // Match section headers: ## 1.1 Title or ## Title
    const sectionMatch = line.match(/^##\s+(?:\d+\.\d+\s+)?(.+)$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }
    
    // Match checklist items: - [ ] Item text [TAGS]
    const itemMatch = line.match(/^-\s*\[\s*\]\s*(.+)$/);
    if (itemMatch && currentPhase) {
      let itemText = itemMatch[1].trim();
      const tags: string[] = [];
      let dueOffset: number | null = null;
      let isRecurring: string | null = null;
      
      // Extract tags
      const tagMatches = itemText.matchAll(/\[([^\]]+)\]/g);
      for (const match of tagMatches) {
        const tag = match[1];
        
        // Parse due offset: [DUE:LAUNCH-14] or [DUE:LAUNCH+7]
        const dueMatch = tag.match(/^DUE:LAUNCH([+-]\d+)$/i);
        if (dueMatch) {
          dueOffset = parseInt(dueMatch[1]);
          continue;
        }
        
        // Parse recurring: [DAILY] or [WEEKLY]
        if (tag.toUpperCase() === 'DAILY') {
          isRecurring = 'daily';
          continue;
        }
        if (tag.toUpperCase() === 'WEEKLY') {
          isRecurring = 'weekly';
          continue;
        }
        
        // All other tags
        tags.push(tag.toUpperCase());
      }
      
      // Clean item text (remove tags)
      itemText = itemText.replace(/\s*\[[^\]]+\]/g, '').trim();
      
      items.push({
        phase: currentPhase,
        section: currentSection,
        item_text: itemText,
        sort_order: sortOrder++,
        tags,
        due_offset: dueOffset,
        is_recurring: isRecurring,
      });
    }
  }
  
  return { phases, items };
}
