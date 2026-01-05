// Basic utility functions

export function needsBreakdown(text: string): boolean {
  const bigTaskIndicators = [
    /^(build|create|develop|design|write|edit|launch|implement|complete)\s+(a|the|my|our)\s+\w+/i,
    /entire|whole|full|complete/i,
    /project|system|platform|application|book|novel|course|program/i,
  ];
  const isShort = text.split(' ').length <= 5;
  if (isShort) return false;
  return bigTaskIndicators.some(pattern => pattern.test(text));
}

export function isVagueTask(text: string): boolean {
  const vagueIndicators = [
    /^(think about|consider|look into|explore|research|figure out|work on)/i,
    /^(need to|should|want to|have to)\s+(build|create|make|do|start)/i,
  ];
  const clearTaskIndicators = [
    /^(check|send|email|call|reply|review|read|fix|update|schedule|book|buy|pay)/i,
  ];
  if (clearTaskIndicators.some(p => p.test(text))) return false;
  return vagueIndicators.some(p => p.test(text));
}

export function inferFocusLevel(text: string): string {
  const highFocus = [/edit|write|develop|build|design|create|analyze|plan|debug|refactor/i];
  const lowFocus = [/check|send|email|call|reply|schedule|book|buy|pay|remind|look|find/i];
  if (lowFocus.some(p => p.test(text))) return 'low';
  if (highFocus.some(p => p.test(text))) return 'high';
  return 'medium';
}

export function getDayOfWeek(): string {
  return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][new Date().getDay()];
}

export function getTimeOfDay(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

export function normalizeUser(user: string): string {
  return user.toLowerCase().trim();
}

export function getPreviousDate(dateStr: string): string {
  const date = new Date(dateStr);
  date.setDate(date.getDate() - 1);
  return date.toISOString().split('T')[0];
}

// Calculate next due date for recurring tasks
// Supports: daily, weekdays, weekly, biweekly, monthly, yearly
// Also supports specific days: "mon", "fri", "mon,thu", "tue,thu,sat"
export function getNextDueDate(currentDue: string | null, recurrence: string): string {
  const base = currentDue ? new Date(currentDue) : new Date();
  const dayMap: Record<string, number> = {
    'sun': 0, 'mon': 1, 'tue': 2, 'wed': 3, 'thu': 4, 'fri': 5, 'sat': 6
  };
  
  switch (recurrence.toLowerCase()) {
    case 'daily':
      base.setDate(base.getDate() + 1);
      break;
    case 'weekdays':
      // Move to next weekday (Mon-Fri)
      do {
        base.setDate(base.getDate() + 1);
      } while (base.getDay() === 0 || base.getDay() === 6);
      break;
    case 'weekly':
      base.setDate(base.getDate() + 7);
      break;
    case 'biweekly':
      base.setDate(base.getDate() + 14);
      break;
    case 'monthly':
      base.setMonth(base.getMonth() + 1);
      break;
    case 'yearly':
      base.setFullYear(base.getFullYear() + 1);
      break;
    default:
      // Handle specific days: "mon", "fri", "mon,thu", etc.
      const targetDays = recurrence.toLowerCase().split(',')
        .map(d => dayMap[d.trim()])
        .filter(d => d !== undefined);
      if (targetDays.length > 0) {
        // Find next occurrence of any target day
        do {
          base.setDate(base.getDate() + 1);
        } while (!targetDays.includes(base.getDay()));
      }
      break;
  }
  
  return base.toISOString().split('T')[0];
}

// ==================
// JOURNAL HELPERS
// ==================

export interface ExtractedEntity {
  type: 'person' | 'project' | 'topic' | 'place';
  value: string;
  sentiment?: 'positive' | 'negative' | 'neutral';
}

// Extract entities from journal content
export function extractEntities(content: string): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  const seen = new Set<string>();
  
  // Helper to add unique entities
  const addEntity = (type: ExtractedEntity['type'], value: string, sentiment?: ExtractedEntity['sentiment']) => {
    const key = `${type}:${value.toLowerCase()}`;
    if (!seen.has(key) && value.length > 1) {
      seen.add(key);
      entities.push({ type, value, sentiment: sentiment || detectSentiment(content, value) });
    }
  };
  
  // 1. Extract people - names after certain patterns
  const personPatterns = [
    /(?:talked to|spoke with|met with|called|emailed|texted|saw|visited|helped|asked|told)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g,
    /(?:with|from|by)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:today|yesterday|this|last|about|regarding)/gi,
    /([A-Z][a-z]+)\s+(?:said|told|asked|helped|called|texted|mentioned|suggested)/g,
  ];
  
  for (const pattern of personPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1].trim();
      // Filter out common non-names
      if (!isCommonWord(name)) {
        addEntity('person', name);
      }
    }
  }
  
  // 2. Extract projects - known project keywords and capitalized multi-word phrases
  const projectPatterns = [
    /(?:working on|progress on|finished|completed|started|launched)\s+(?:the\s+)?([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)/g,
    /(?:project|launch|book|app|website|platform|system):\s*([A-Za-z][a-zA-Z\s]+)/gi,
  ];
  
  for (const pattern of projectPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const project = match[1].trim();
      if (!isCommonWord(project) && project.length > 2) {
        addEntity('project', project);
      }
    }
  }
  
  // 3. Extract topics - common life areas
  const topicKeywords: Record<string, string[]> = {
    'work': ['work', 'job', 'office', 'meeting', 'deadline', 'project', 'client', 'boss', 'coworker', 'career'],
    'health': ['health', 'exercise', 'workout', 'gym', 'sleep', 'tired', 'sick', 'doctor', 'medicine', 'headache', 'energy'],
    'family': ['family', 'mom', 'dad', 'parents', 'brother', 'sister', 'kids', 'children', 'spouse', 'wife', 'husband'],
    'money': ['money', 'budget', 'savings', 'debt', 'bills', 'income', 'expenses', 'financial', 'invest', 'salary'],
    'relationships': ['friend', 'friendship', 'dating', 'relationship', 'partner', 'social', 'hangout', 'conversation'],
    'creativity': ['writing', 'creative', 'art', 'music', 'design', 'idea', 'inspiration', 'create', 'build'],
    'learning': ['learning', 'studying', 'reading', 'course', 'book', 'skill', 'practice', 'improve'],
    'spiritual': ['prayer', 'meditation', 'church', 'faith', 'God', 'spiritual', 'grateful', 'blessing'],
  };
  
  const lowerContent = content.toLowerCase();
  for (const [topic, keywords] of Object.entries(topicKeywords)) {
    if (keywords.some(kw => lowerContent.includes(kw))) {
      addEntity('topic', topic);
    }
  }
  
  // 4. Extract places
  const placePatterns = [
    /(?:at|in|to|from|visited|went to)\s+(?:the\s+)?([A-Z][a-z]+(?:'s)?(?:\s+[A-Z][a-z]+)*)/g,
  ];
  
  const knownPlaceTypes = ['cafe', 'restaurant', 'office', 'home', 'gym', 'church', 'store', 'park', 'library', 'hospital', 'school'];
  
  for (const pattern of placePatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const place = match[1].trim();
      // Check if it looks like a place
      if (knownPlaceTypes.some(pt => place.toLowerCase().includes(pt)) || 
          /(?:Coffee|Cafe|Restaurant|Gym|Office|Center|Mall|Park|Church|Hospital)/i.test(place)) {
        addEntity('place', place);
      }
    }
  }
  
  return entities;
}

// Detect sentiment around a term in content
function detectSentiment(content: string, term: string): 'positive' | 'negative' | 'neutral' {
  const lowerContent = content.toLowerCase();
  const termIndex = lowerContent.indexOf(term.toLowerCase());
  
  if (termIndex === -1) return 'neutral';
  
  // Check words around the term (±50 chars)
  const start = Math.max(0, termIndex - 50);
  const end = Math.min(content.length, termIndex + term.length + 50);
  const context = lowerContent.slice(start, end);
  
  const positiveWords = ['happy', 'great', 'amazing', 'wonderful', 'love', 'excited', 'grateful', 'thankful', 'awesome', 'good', 'excellent', 'fantastic', 'helpful', 'supportive', 'kind', 'fun', 'enjoyed'];
  const negativeWords = ['frustrated', 'angry', 'sad', 'annoyed', 'upset', 'stressed', 'worried', 'anxious', 'disappointed', 'bad', 'terrible', 'awful', 'difficult', 'hard', 'struggle', 'problem', 'issue', 'conflict'];
  
  const posCount = positiveWords.filter(w => context.includes(w)).length;
  const negCount = negativeWords.filter(w => context.includes(w)).length;
  
  if (posCount > negCount) return 'positive';
  if (negCount > posCount) return 'negative';
  return 'neutral';
}

// Check if a word is too common to be an entity
function isCommonWord(word: string): boolean {
  const commonWords = new Set([
    'the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'your', 'his', 'her', 'its', 'our', 'their',
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'us', 'them',
    'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how',
    'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'not', 'only', 'same', 'so', 'than', 'too', 'very',
    'just', 'also', 'now', 'here', 'there', 'then', 'once', 'today', 'yesterday', 'tomorrow', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'morning', 'afternoon', 'evening', 'night', 'week', 'month', 'year',
    'really', 'actually', 'basically', 'definitely', 'probably', 'maybe', 'perhaps',
    'think', 'feel', 'know', 'want', 'need', 'like', 'love', 'hate', 'hope', 'wish',
    'good', 'bad', 'great', 'nice', 'new', 'old', 'big', 'small', 'long', 'short',
    'first', 'last', 'next', 'many', 'much', 'little', 'lot', 'lots',
    'time', 'day', 'thing', 'things', 'way', 'life', 'work', 'world', 'people', 'person',
    'but', 'and', 'or', 'if', 'because', 'as', 'until', 'while', 'although', 'since', 'unless',
    'about', 'after', 'before', 'between', 'during', 'for', 'from', 'in', 'into', 'of', 'on', 'over', 'through', 'to', 'under', 'up', 'with'
  ]);
  return commonWords.has(word.toLowerCase());
}

// Refine raw journal content into a cleaner version for Penzu
export function refineJournalContent(rawContent: string, entryType: string): string {
  let refined = rawContent;
  
  // 1. Fix common typos and capitalization
  refined = refined.replace(/\bi\b/g, 'I');
  refined = refined.replace(/(\.\s+)([a-z])/g, (_, p1, p2) => p1 + p2.toUpperCase());
  
  // 2. Ensure sentences end with punctuation
  const sentences = refined.split(/(?<=[.!?])\s+/);
  refined = sentences.map(s => {
    s = s.trim();
    if (s && !/[.!?]$/.test(s)) {
      s += '.';
    }
    return s;
  }).join(' ');
  
  // 3. Clean up excessive whitespace
  refined = refined.replace(/\s+/g, ' ').trim();
  
  // 4. Add entry type header for Penzu
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  
  let header = '';
  switch (entryType) {
    case 'morning':
      header = `☀️ Morning Entry - ${dateStr}\n\n`;
      break;
    case 'evening':
      header = `🌙 Evening Entry - ${dateStr}\n\n`;
      break;
    case 'reflection':
      header = `💭 Reflection - ${dateStr}\n\n`;
      break;
    case 'braindump':
      header = `🧠 Brain Dump - ${dateStr}, ${timeStr}\n\n`;
      break;
    default:
      header = `📓 ${dateStr}\n\n`;
  }
  
  // 5. Format paragraphs
  const paragraphs = refined.split(/\n\n+/);
  refined = paragraphs.map(p => p.trim()).filter(p => p).join('\n\n');
  
  return header + refined;
}
