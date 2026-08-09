import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import '../design_system/components/maybesitter_bottom_navigation.dart';
import '../features/activity/activity_screen.dart';
import '../features/capture/capture_composer_screen.dart';
import '../features/capture/clarification_sheet_screen.dart';
import '../features/capture/extraction_review_screen.dart';
import '../features/capture/success_save_screen.dart';
import '../features/commitment_details/commitment_details_screen.dart';
import '../features/onboarding/onboarding_screen.dart';
import '../features/settings/appearance_screen.dart';
import '../features/settings/notifications_permission_screen.dart';
import '../features/settings/privacy_screen.dart';
import '../features/settings/settings_screen.dart';
import '../features/trust/trust_center_screen.dart';
import '../features/trust/what_maybesitter_knows_screen.dart';
import '../features/today/today_screen.dart';
import '../features/upcoming/upcoming_screen.dart';

final GlobalKey<NavigatorState> _rootNavigatorKey = GlobalKey<NavigatorState>(
  debugLabel: 'root',
);
final GlobalKey<NavigatorState> _shellNavigatorKey = GlobalKey<NavigatorState>(
  debugLabel: 'shell',
);

final appRouter = GoRouter(
  navigatorKey: _rootNavigatorKey,
  initialLocation: '/today',
  routes: [
    GoRoute(
      path: '/onboarding',
      builder: (context, state) => const OnboardingScreen(),
    ),

    // Bottom Navigation Shell Route
    ShellRoute(
      navigatorKey: _shellNavigatorKey,
      builder: (context, state, child) {
        int index = 0;
        if (state.matchedLocation.startsWith('/upcoming')) {
          index = 1;
        } else if (state.matchedLocation.startsWith('/activity')) {
          index = 2;
        } else if (state.matchedLocation.startsWith('/settings')) {
          index = 3;
        }

        return Scaffold(
          body: child,
          bottomNavigationBar: MaybesitterBottomNavigation(
            currentIndex: index,
            onTap: (i) {
              switch (i) {
                case 0:
                  context.go('/today');
                  break;
                case 1:
                  context.go('/upcoming');
                  break;
                case 2:
                  context.go('/activity');
                  break;
                case 3:
                  context.go('/settings');
                  break;
              }
            },
          ),
        );
      },
      routes: [
        GoRoute(
          path: '/today',
          builder: (context, state) => const TodayScreen(),
        ),
        GoRoute(
          path: '/upcoming',
          builder: (context, state) => const UpcomingScreen(),
        ),
        GoRoute(
          path: '/activity',
          builder: (context, state) => const ActivityScreen(),
        ),
        GoRoute(
          path: '/settings',
          builder: (context, state) => const SettingsScreen(),
          routes: [
            GoRoute(
              path: 'appearance',
              parentNavigatorKey: _rootNavigatorKey,
              builder: (context, state) => const AppearanceScreen(),
            ),
            GoRoute(
              path: 'privacy',
              parentNavigatorKey: _rootNavigatorKey,
              builder: (context, state) => const PrivacyScreen(),
            ),
            GoRoute(
              path: 'notifications',
              parentNavigatorKey: _rootNavigatorKey,
              builder: (context, state) =>
                  const NotificationsPermissionScreen(),
            ),
            GoRoute(
              path: 'trust',
              parentNavigatorKey: _rootNavigatorKey,
              builder: (context, state) => const TrustCenterScreen(),
              routes: [
                GoRoute(
                  path: 'knows',
                  parentNavigatorKey: _rootNavigatorKey,
                  builder: (context, state) =>
                      const WhatMaybeSitterKnowsScreen(),
                ),
              ],
            ),
          ],
        ),
      ],
    ),

    // Modal Capture Routes
    GoRoute(
      path: '/capture',
      parentNavigatorKey: _rootNavigatorKey,
      builder: (context, state) => const CaptureComposerScreen(),
      routes: [
        GoRoute(
          path: 'review',
          parentNavigatorKey: _rootNavigatorKey,
          builder: (context, state) => const ExtractionReviewScreen(),
        ),
        GoRoute(
          path: 'clarification',
          parentNavigatorKey: _rootNavigatorKey,
          builder: (context, state) => const ClarificationSheetScreen(),
        ),
        GoRoute(
          path: 'success',
          parentNavigatorKey: _rootNavigatorKey,
          builder: (context, state) => const SuccessSaveScreen(),
        ),
      ],
    ),

    // Commitment Details Route
    GoRoute(
      path: '/commitments/:id',
      parentNavigatorKey: _rootNavigatorKey,
      builder: (context, state) {
        final id = state.pathParameters['id'] ?? '';
        return CommitmentDetailsScreen(id: id);
      },
    ),
  ],
);
