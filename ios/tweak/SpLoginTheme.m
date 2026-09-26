// SpLoginTheme.m —— 官方样式 token 的 Objective-C 投影（P10-B）

#import "SpLoginTheme.h"

static UIColor *SPLoginColor(CGFloat r, CGFloat g, CGFloat b) {
    return [UIColor colorWithRed:(r / 255.0) green:(g / 255.0) blue:(b / 255.0) alpha:1.0];
}

@implementation SpLoginTheme

+ (UIColor *)primary      { return SPLoginColor(0x2E, 0xC4, 0xB6); }
+ (UIColor *)danger       { return SPLoginColor(0xEA, 0x35, 0x53); }
+ (UIColor *)accent       { return SPLoginColor(0xFF, 0x9F, 0x1C); }
+ (UIColor *)infoBlue     { return SPLoginColor(0x55, 0xAC, 0xEE); }
+ (UIColor *)panel        { return SPLoginColor(0xFA, 0xFA, 0xFA); }
+ (UIColor *)scrim        { return [UIColor colorWithWhite:0.0 alpha:0.62]; }
+ (UIColor *)textPrimary  { return SPLoginColor(0x41, 0x41, 0x41); }
+ (UIColor *)textSecondary{ return SPLoginColor(0x51, 0x51, 0x51); }
+ (UIColor *)textDisabled { return SPLoginColor(0xC9, 0xC9, 0xC9); }
+ (UIColor *)hairline     { return SPLoginColor(0xDD, 0xDD, 0xDD); }

+ (CGFloat)radiusPanel    { return 32.0; }
+ (CGFloat)radiusButton   { return 24.0; }
+ (CGFloat)radiusField    { return 18.0; }
+ (CGFloat)glowWidth      { return 6.0; }
+ (CGFloat)shadowOpacity  { return 0.20; }
+ (CGFloat)shadowRadius   { return 20.0; }

+ (UIFont *)fontOfSize:(CGFloat)size weight:(UIFontWeight)weight {
    return [UIFont systemFontOfSize:size weight:weight];
}

+ (UIFont *)monospacedDigitFontOfSize:(CGFloat)size weight:(UIFontWeight)weight {
    UIFont *base = [UIFont monospacedDigitSystemFontOfSize:size weight:weight];
    return base != nil ? base : [UIFont systemFontOfSize:size weight:weight];
}

+ (void)applyPrimaryButtonStyle:(UIButton *)button {
    button.backgroundColor = [self primary];
    button.layer.cornerRadius = [self radiusButton];
    button.layer.shadowColor = [self primary].CGColor;
    button.layer.shadowOpacity = (float)[self shadowOpacity];
    button.layer.shadowRadius = [self shadowRadius] / 2.0;
    button.layer.shadowOffset = CGSizeZero;
    button.titleLabel.font = [self fontOfSize:19.0 weight:UIFontWeightSemibold];
    [button setTitleColor:[UIColor whiteColor] forState:UIControlStateNormal];
    [button setTitleColor:[self textDisabled] forState:UIControlStateDisabled];
}

+ (void)applySecondaryButtonStyle:(UIButton *)button {
    button.backgroundColor = [self danger];
    button.layer.cornerRadius = [self radiusButton];
    button.layer.shadowColor = [self danger].CGColor;
    button.layer.shadowOpacity = (float)[self shadowOpacity];
    button.layer.shadowRadius = [self shadowRadius] / 2.0;
    button.layer.shadowOffset = CGSizeZero;
    button.titleLabel.font = [self fontOfSize:19.0 weight:UIFontWeightSemibold];
    [button setTitleColor:[UIColor whiteColor] forState:UIControlStateNormal];
    [button setTitleColor:[self textDisabled] forState:UIControlStateDisabled];
}

+ (void)applyPanelStyle:(UIView *)view {
    view.backgroundColor = [self panel];
    view.layer.cornerRadius = [self radiusPanel];
    view.layer.shadowColor = [UIColor blackColor].CGColor;
    view.layer.shadowOpacity = 0.12f;
    view.layer.shadowRadius = 8.0;
    view.layer.shadowOffset = CGSizeMake(0.0, 4.0);
}

@end
