import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import 'offline_banner.dart';

/// Shared page shell: brand background, offline banner slot, safe-area
/// handling. Every screen goes through here so padding and background never
/// drift between routes.
class MaybesitterScaffold extends StatelessWidget {
  final PreferredSizeWidget? appBar;
  final Widget body;
  final Widget? floatingActionButton;
  final FloatingActionButtonLocation? floatingActionButtonLocation;
  final Widget? bottomNavigationBar;
  final Widget? bottomBar;
  final bool isOffline;
  final bool resizeToAvoidBottomInset;

  const MaybesitterScaffold({
    super.key,
    this.appBar,
    required this.body,
    this.floatingActionButton,
    this.floatingActionButtonLocation,
    this.bottomNavigationBar,
    this.bottomBar,
    this.isOffline = false,
    this.resizeToAvoidBottomInset = true,
  });

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;

    return Scaffold(
      backgroundColor: colors.background,
      appBar: appBar,
      resizeToAvoidBottomInset: resizeToAvoidBottomInset,
      body: SafeArea(
        top: appBar == null,
        bottom: false,
        child: Column(
          children: [
            if (isOffline) const OfflineBanner(),
            Expanded(child: body),
          ],
        ),
      ),
      floatingActionButton: floatingActionButton,
      floatingActionButtonLocation: floatingActionButtonLocation,
      bottomNavigationBar: bottomBar ?? bottomNavigationBar,
    );
  }
}

/// Sticky bottom action bar — sits above the safe area with a hairline and a
/// soft upward shadow so it reads as a shelf, not a floating island.
class StickyActionBar extends StatelessWidget {
  final Widget child;

  const StickyActionBar({super.key, required this.child});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;

    return Container(
      decoration: BoxDecoration(
        color: colors.surface,
        border: Border(top: BorderSide(color: colors.border)),
      ),
      child: SafeArea(top: false, child: child),
    );
  }
}
