import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import '../tokens/colors.dart';

abstract class AppTextStyles {
  static TextStyle display(SemanticColors colors) => GoogleFonts.manrope(
    fontSize: 32.0,
    fontWeight: FontWeight.bold,
    height: 1.25,
    color: colors.textPrimary,
  );

  static TextStyle pageTitle(SemanticColors colors) => GoogleFonts.manrope(
    fontSize: 24.0,
    fontWeight: FontWeight.bold,
    height: 1.3,
    color: colors.textPrimary,
  );

  static TextStyle sectionTitle(SemanticColors colors) => GoogleFonts.manrope(
    fontSize: 18.0,
    fontWeight: FontWeight.w700,
    height: 1.35,
    color: colors.textPrimary,
  );

  static TextStyle cardTitle(SemanticColors colors) => GoogleFonts.manrope(
    fontSize: 16.0,
    fontWeight: FontWeight.w600,
    height: 1.4,
    color: colors.textPrimary,
  );

  static TextStyle body(SemanticColors colors) => GoogleFonts.manrope(
    fontSize: 15.0,
    fontWeight: FontWeight.w400,
    height: 1.45,
    color: colors.textPrimary,
  );

  static TextStyle supportingBody(SemanticColors colors) => GoogleFonts.manrope(
    fontSize: 14.0,
    fontWeight: FontWeight.w400,
    height: 1.4,
    color: colors.textSecondary,
  );

  static TextStyle label(SemanticColors colors) => GoogleFonts.manrope(
    fontSize: 12.0,
    fontWeight: FontWeight.w600,
    letterSpacing: 0.5,
    height: 1.3,
    color: colors.textSecondary,
  );

  static TextStyle caption(SemanticColors colors) => GoogleFonts.manrope(
    fontSize: 11.0,
    fontWeight: FontWeight.w500,
    height: 1.3,
    color: colors.textMuted,
  );

  static TextStyle buttonText(SemanticColors colors) => GoogleFonts.manrope(
    fontSize: 15.0,
    fontWeight: FontWeight.w600,
    height: 1.2,
    color: colors.textPrimary,
  );
}
