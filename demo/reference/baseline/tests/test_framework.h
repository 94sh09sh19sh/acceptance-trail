#ifndef TEST_FRAMEWORK_H
#define TEST_FRAMEWORK_H

/*
 * Minimal unit test macros (GCC/Clang). No third-party framework.
 *
 * Declare a test with TEST(name) { ... } in any C file under tests/; it registers
 * itself, so there is no list to maintain. Tests run sorted by name, and each
 * prints one PASS or FAIL line, followed by a SUMMARY line.
 * A failed CHECK ends that test (it returns) and records where it failed.
 */

void tf_register(const char *name, void (*fn)(void));
void tf_fail(const char *file, int line, const char *text);
void tf_fail_eq(const char *file, int line, const char *expected_text, const char *actual_text,
                long long expected, long long actual);

#define TEST(name)                                                    \
    static void name(void);                                           \
    __attribute__((constructor)) static void name##_register(void)    \
    {                                                                 \
        tf_register(#name, name);                                     \
    }                                                                 \
    static void name(void)

/* Fails the test when cond is false. */
#define CHECK(cond)                                                   \
    do {                                                              \
        if (!(cond)) {                                                \
            tf_fail(__FILE__, __LINE__, "CHECK(" #cond ")");          \
            return;                                                   \
        }                                                             \
    } while (0)

/* Same, with a plain-language message that is printed on failure. */
#define CHECK_MSG(cond, msg)                                          \
    do {                                                              \
        if (!(cond)) {                                                \
            tf_fail(__FILE__, __LINE__, msg " [CHECK(" #cond ")]");   \
            return;                                                   \
        }                                                             \
    } while (0)

/* Fails the test unless both integer expressions are equal. */
#define CHECK_EQ(expected, actual)                                    \
    do {                                                              \
        const long long tf_e_ = (long long)(expected);                \
        const long long tf_a_ = (long long)(actual);                  \
        if (tf_e_ != tf_a_) {                                         \
            tf_fail_eq(__FILE__, __LINE__, #expected, #actual, tf_e_, tf_a_); \
            return;                                                   \
        }                                                             \
    } while (0)

#endif /* TEST_FRAMEWORK_H */
