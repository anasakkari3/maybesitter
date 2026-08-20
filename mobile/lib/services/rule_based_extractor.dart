import '../models/commitment.dart';

/// Reads commitments out of what a person actually wrote.
///
/// The rules are ported from the backend's `ruleBasedExtractor.ts` so the two
/// agree about what a sentence means, but this runs on the device: a personal
/// assistant that needs a server reachable before it can understand you is not
/// one you can rely on in a corridor.
///
/// One deliberate difference. The backend detects several commitments in one
/// breath and only lowers its confidence; here they are actually separated,
/// because "لازم أكون بالنادي على السبعة لازم أكون بالمكتب" is two things a
/// person has to do, and collapsing it into one loses the second.
class RuleBasedExtractor {
  const RuleBasedExtractor();

  /// The words people start a new intention with. Each one that appears after
  /// the beginning of the text opens a new commitment.
  static final _boundary = RegExp(
    r'(?=(?:^|\s)(?:لازم|بدي|بديت|محتاج|احتاج|أحتاج|ضروري|يمكن|ذكرني|ذكريني|عليّ|علي\s)'
    r'|(?:^|\s)(?:i\s+(?:must|need\s+to|have\s+to|should|want\s+to|will|am\s+going\s+to))'
    r'|(?:^|\s)(?:remind\s+me\s+to))',
    caseSensitive: false,
  );

  /// Words that put one thing after another: "go to the doctor **and then**
  /// work" is two errands. A bare "and" is not here on purpose -- "خبز وحليب"
  /// is one trip to the shop, and splitting on it would invent commitments.
  static final _sequencing = RegExp(
    r'(?:\s(?:وبعدين|وبعدها|وبعد ذلك|ثم|بعدين)\s)'
    r'|(?:\s(?:and\s+then|then\s+i|,\s*then)\s)',
    caseSensitive: false,
  );

  List<Commitment> extract(String raw, {DateTime? now}) {
    final at = now ?? DateTime.now();
    final text = raw.trim();
    if (text.isEmpty) return const [];

    // A date said once at the front applies to everything after it: "بكرة
    // الصبح" opens the whole plan, not just its first clause.
    final leadingDate = _dateIn(text, at);

    final segments = _split(text);
    final commitments = <Commitment>[];

    for (var i = 0; i < segments.length; i++) {
      final segment = segments[i];
      final title = _titleOf(segment);
      if (title.isEmpty) continue;

      commitments.add(
        Commitment(
          id: 'capture-${at.microsecondsSinceEpoch}-$i',
          title: title,
          scheduledDate: _dateIn(segment, at) ?? leadingDate,
          startTime: _timeIn(segment),
          priority: _priorityIn(segment),
          status: CommitmentStatus.pending,
        ),
      );
    }

    return commitments;
  }

  List<String> _split(String text) {
    final byPunctuation = text
        .split(RegExp(r'[\n،؛,;.]+'))
        .map((part) => part.trim())
        .where((part) => part.isNotEmpty);

    final segments = <String>[];
    for (final sentence in byPunctuation) {
      for (final clause in sentence.split(_sequencing)) {
        final pieces = clause
            .split(_boundary)
            .map((piece) => piece.trim())
            .where((piece) => piece.isNotEmpty);
        segments.addAll(pieces);
      }
    }
    return segments.isEmpty ? [text] : segments;
  }

  // ── time ──────────────────────────────────────────────────────────────

  /// Arabic-Indic and Eastern-Arabic digits, so "الساعة ٥" reads as five.
  static String _westernDigits(String value) {
    const arabic = '٠١٢٣٤٥٦٧٨٩';
    const eastern = '۰۱۲۳۴۵۶۷۸۹';
    return value.split('').map((ch) {
      final a = arabic.indexOf(ch);
      if (a >= 0) return '$a';
      final e = eastern.indexOf(ch);
      if (e >= 0) return '$e';
      return ch;
    }).join();
  }

  /// Hours people say as words rather than digits.
  ///
  /// Both the formal forms and the spoken ones. People write "على الخمسة", not
  /// "على الخامسة", and an assistant that only reads the textbook spelling
  /// silently drops the time out of half of what it is told.
  ///
  /// Ordered longest-first so "الحادية عشرة" is matched before "الحادية".
  static const _spelledHours = <String, int>{
    'الحادية عشرة': 11, 'الثانية عشرة': 12, 'الاثنتي عشرة': 12,
    'الاتناشر': 12, 'الحداشر': 11,
    'الواحدة': 1, 'الوحدة': 1,
    'الثانية': 2, 'التانية': 2, 'الاتنين': 2, 'التنتين': 2,
    'الثالثة': 3, 'التالتة': 3, 'التلاتة': 3,
    'الرابعة': 4, 'الاربعة': 4, 'الأربعة': 4,
    'الخامسة': 5, 'الخمسة': 5,
    'السادسة': 6, 'الستة': 6,
    'السابعة': 7, 'السبعة': 7,
    'الثامنة': 8, 'التامنة': 8, 'التمانية': 8,
    'التاسعة': 9, 'التسعة': 9,
    'العاشرة': 10, 'العشرة': 10,
  };

  static final _pm = RegExp(r'(pm|مساء|مساءً|المسا|المساء|بالليل|الليل|ظهرا|الظهر)');
  static final _am = RegExp(r'(am|صباحا|صباحاً|الصبح|صباح)');

  String? _timeIn(String segment) {
    final normalized = _westernDigits(segment);

    // "الساعة 5", "على 5:30", "at 3pm", or a bare "5 pm".
    final match =
        RegExp(
          r'(?:\b(?:at|by|around)\b|الساعة|الساعه|عند|على)\s*(\d{1,2})(?::(\d{2}))?\s*'
          r'(am|pm|صباحا|صباحاً|الصبح|مساء|مساءً|المسا|المساء|بالليل)?',
          caseSensitive: false,
        ).firstMatch(normalized) ??
        RegExp(
          r'\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|صباحا|صباحاً|الصبح|مساء|مساءً|المسا|المساء|بالليل)',
          caseSensitive: false,
        ).firstMatch(normalized);

    if (match != null) {
      var hour = int.parse(match.group(1)!);
      final minute = int.tryParse(match.group(2) ?? '0') ?? 0;
      if (hour > 23 || minute > 59) return null;
      return _clock(hour, minute, segment);
    }

    for (final entry in _spelledHours.entries) {
      if (segment.contains(entry.key)) {
        return _clock(entry.value, 0, segment);
      }
    }

    // No clock at all -- fall back to the part of day, if one was named.
    if (RegExp(r'\bmorning\b|الصبح|صباح').hasMatch(segment)) return '09:00';
    if (RegExp(r'\bafternoon\b|بعد الظهر|بعد الضهر').hasMatch(segment)) {
      return '14:00';
    }
    if (RegExp(r'\bevening\b|المسا|المساء|مساء').hasMatch(segment)) {
      return '18:00';
    }
    return null;
  }

  String _clock(int hour, int minute, String segment) {
    var h = hour;
    if (_pm.hasMatch(segment) && h < 12) h += 12;
    if (_am.hasMatch(segment) && h == 12) h = 0;
    return '${h.toString().padLeft(2, '0')}:${minute.toString().padLeft(2, '0')}';
  }

  // ── date ──────────────────────────────────────────────────────────────

  /// Null when no date was mentioned.
  ///
  /// The stub defaulted everything to tomorrow, which quietly invented a
  /// deadline the person never gave. An undated commitment is a real state.
  DateTime? _dateIn(String segment, DateTime now) {
    final today = DateTime(now.year, now.month, now.day);

    if (RegExp(r'(بعد بكرا|بعد بكرة|بعد غد|بعد غداً)').hasMatch(segment) ||
        RegExp(r'\b(day after tomorrow|after tomorrow)\b', caseSensitive: false)
            .hasMatch(segment)) {
      return today.add(const Duration(days: 2));
    }
    if (RegExp(r'(بكرا|بكرة|غدا|غداً)').hasMatch(segment) ||
        RegExp(r'\btomorrow\b', caseSensitive: false).hasMatch(segment)) {
      return today.add(const Duration(days: 1));
    }
    if (RegExp(r'(اليوم|النهارده|اليومه)').hasMatch(segment) ||
        RegExp(r'\b(today|tonight)\b', caseSensitive: false).hasMatch(segment)) {
      return today;
    }
    if (RegExp(r'(الأسبوع الجاي|الاسبوع الجاي|الأسبوع القادم)').hasMatch(segment) ||
        RegExp(r'\bnext week\b', caseSensitive: false).hasMatch(segment)) {
      return today.add(const Duration(days: 7));
    }
    return null;
  }

  // ── insistence ────────────────────────────────────────────────────────

  CommitmentPriority _priorityIn(String segment) {
    final lower = segment.toLowerCase();
    // Checked before "must", so "مش ضروري" is not read as "ضروري".
    if (RegExp(r'(مش ضروري|يمكن|عادي|لو فيه وقت)').hasMatch(lower) ||
        RegExp(r'\b(maybe|probably|sometime|optional|if i can)\b').hasMatch(lower)) {
      return CommitmentPriority.nice;
    }
    if (RegExp(r'(ضروري|مستعجل|مهم|لازم)').hasMatch(lower) ||
        RegExp(r'\b(must|urgent|asap|critical|important|have to|need to)\b')
            .hasMatch(lower)) {
      return CommitmentPriority.must;
    }
    return CommitmentPriority.should;
  }

  // ── title ─────────────────────────────────────────────────────────────

  /// What is left once the scaffolding is removed: the thing to do.
  String _titleOf(String segment) {
    var title = segment;

    // Times and dates say when, not what. The English form goes first: strip
    // the digits before "at 3pm" and the stranded "at" survives into the title.
    title = title
        .replaceAll(
          RegExp(r'\b(?:at|by|around)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?',
              caseSensitive: false),
          ' ',
        )
        .replaceAll(
          RegExp(
            r'(?:الساعة|الساعه|عند|على)?\s*[0-9٠-٩۰-۹]{1,2}(?::[0-9٠-٩۰-۹]{2})?\s*'
            r'(?:صباحا|صباحاً|الصبح|مساء|مساءً|المسا|المساء|بالليل|am|pm)',
            caseSensitive: false,
          ),
          ' ',
        )
        .replaceAll(
          RegExp(r'(?:الساعة|الساعه|عند|على)\s*[0-9٠-٩۰-۹]{1,2}(?::[0-9٠-٩۰-۹]{2})?'),
          ' ',
        );

    for (final spelled in _spelledHours.keys) {
      title = title.replaceAll(RegExp('(?:على|عند|الساعة|الساعه)?\\s*$spelled'), ' ');
    }

    title = title
        .replaceAll(
          RegExp(
            r'(بعد بكرا|بعد بكرة|بعد غداً|بعد غد|اليوم|النهارده|اليومه|بكرا|بكرة|'
            r'غداً|غدا|الأسبوع الجاي|الاسبوع الجاي|الأسبوع القادم|الصبح|صباحاً|'
            r'صباحا|صباح|بعد الظهر|بعد الضهر|المساء|المسا|مساءً|مساء|بالليل|الليل)',
          ),
          ' ',
        )
        .replaceAll(
          RegExp(
            r'\b(day after tomorrow|after tomorrow|tomorrow|tonight|today|next week|'
            r'this morning|morning|afternoon|evening)\b',
            caseSensitive: false,
          ),
          ' ',
        );

    // Insistence and the words that introduce an intention.
    title = title
        .replaceAll(
          RegExp(r'(?:^|\s)(ضروري|مستعجل|مهم|لازم|يمكن|عادي|مش ضروري)(?=\s|$)'),
          ' ',
        )
        .replaceAll(
          RegExp(
            r'^\s*(ذكرني اني|ذكرني|ذكريني|بدي|بديت|محتاج|احتاج|أحتاج|عليّ|علي)\s+',
          ),
          '',
        )
        .replaceAll(
          RegExp(
            r'^\s*(?:remind me to|i must|i need to|i have to|i should|i want to|i will|i am going to)\s+',
            caseSensitive: false,
          ),
          '',
        );

    return title.replaceAll(RegExp(r'\s+'), ' ').trim();
  }
}
