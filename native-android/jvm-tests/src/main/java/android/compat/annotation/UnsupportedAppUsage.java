package android.compat.annotation;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * JVM-test stub for the Android framework annotation used by android-all.
 * The annotation is metadata only; the production Android framework supplies
 * the real definition at runtime.
 */
@Retention(RetentionPolicy.CLASS)
@Target({
        ElementType.CONSTRUCTOR,
        ElementType.FIELD,
        ElementType.METHOD,
        ElementType.TYPE
})
public @interface UnsupportedAppUsage {
    int maxTargetSdk() default Integer.MAX_VALUE;
    String trackingBug() default "";
    String implicitMember() default "";
    String expectedSignature() default "";
    String publicAlternatives() default "";
}