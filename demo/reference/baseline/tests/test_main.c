/* Test runner: collects registered tests, runs them sorted by name, prints PASS/FAIL and a summary. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "test_framework.h"

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

#define MAX_TESTS 256
#define MESSAGE_SIZE 512

typedef struct {
    const char *name;
    void (*fn)(void);
} test_case_t;

static test_case_t s_tests[MAX_TESTS];
static int s_test_count;
static int s_current_failed;
static char s_message[MESSAGE_SIZE];

void tf_register(const char *name, void (*fn)(void))
{
    if (s_test_count < MAX_TESTS) {
        s_tests[s_test_count].name = name;
        s_tests[s_test_count].fn = fn;
        s_test_count++;
    }
}

void tf_fail(const char *file, int line, const char *text)
{
    s_current_failed = 1;
    snprintf(s_message, sizeof s_message, "%s:%d: %s", file, line, text);
}

void tf_fail_eq(const char *file, int line, const char *expected_text, const char *actual_text,
                long long expected, long long actual)
{
    s_current_failed = 1;
    snprintf(s_message, sizeof s_message, "%s:%d: CHECK_EQ(%s, %s) expected %lld, got %lld", file, line,
             expected_text, actual_text, expected, actual);
}

static int compare_by_name(const void *a, const void *b)
{
    return strcmp(((const test_case_t *)a)->name, ((const test_case_t *)b)->name);
}

int main(int argc, char **argv)
{
    const char *filter = argc > 1 ? argv[1] : NULL; /* optional: run only tests whose name contains this text */
    int run = 0;
    int failed = 0;

#ifdef _WIN32
    _setmode(_fileno(stdout), _O_BINARY); /* plain LF line ends, so the output can be pasted as evidence */
#endif
    qsort(s_tests, (size_t)s_test_count, sizeof s_tests[0], compare_by_name);
    for (int i = 0; i < s_test_count; i++) {
        if (filter != NULL && strstr(s_tests[i].name, filter) == NULL) {
            continue;
        }
        s_current_failed = 0;
        s_message[0] = '\0';
        s_tests[i].fn();
        run++;
        if (s_current_failed) {
            failed++;
            printf("FAIL %s\n     %s\n", s_tests[i].name, s_message);
        } else {
            printf("PASS %s\n", s_tests[i].name);
        }
    }
    printf("SUMMARY: %d tests, %d passed, %d failed\n", run, run - failed, failed);
    return failed == 0 ? 0 : 1;
}
