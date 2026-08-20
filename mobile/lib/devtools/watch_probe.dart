/// Where the snapshot stops on its way to the wrist.
///
/// The path crosses four boundaries -- Dart, the method channel, WCSession, and
/// the watch -- and a snapshot that never arrives looks identical at every one
/// of them. This reports what each step actually returned.
library;

import 'dart:convert';

import 'package:flutter/material.dart';

import '../models/commitment.dart';
import '../models/pilot_presence.dart';
import '../services/watch_snapshot_bridge.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const _WatchProbeApp());
}

class _WatchProbeApp extends StatefulWidget {
  const _WatchProbeApp();

  @override
  State<_WatchProbeApp> createState() => _WatchProbeAppState();
}

class _WatchProbeAppState extends State<_WatchProbeApp> {
  final List<String> _log = [];

  @override
  void initState() {
    super.initState();
    _run();
  }

  void _say(String line) {
    // ignore: avoid_print
    print('WATCHPROBE: $line');
    if (mounted) setState(() => _log.add(line));
  }

  Future<void> _run() async {
    const bridge = MethodChannelWatchSnapshotBridge();

    final supported = await bridge.isSupported();
    _say('isSupported -> $supported');
    if (!supported) return;

    final generatedAt = DateTime.now().toUtc();
    final snapshot = CommitmentSnapshot.fromCommitments(
      commitments: [
        Commitment(
          id: 'probe-1',
          title: 'Probe commitment',
          scheduledDate: DateTime.now(),
          startTime: '10:00',
          priority: CommitmentPriority.must,
        ),
      ],
      generatedAt: generatedAt,
      expiresAt: generatedAt.add(const Duration(minutes: 30)),
      surface: PilotPresenceSurface.watch,
      titlePrivacy: const SnapshotTitlePrivacy(
        mode: SnapshotTitlePrivacyMode.neverIncludeTitles,
      ),
    );

    final json = jsonEncode(snapshot.toJson());
    _say('payload bytes: ${json.length}');

    final sent = await bridge.publishSnapshot(json);
    _say('publishSnapshot -> $sent');
    if (!sent) {
      final diagnostics = await bridge.diagnostics();
      for (final entry in diagnostics.entries) {
        _say('  ${entry.key} = ${entry.value}');
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: ListView(
              children: [
                for (final line in _log)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: Text(line, style: const TextStyle(fontSize: 13)),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
