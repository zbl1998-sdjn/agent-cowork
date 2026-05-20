#include "json.h"

int kcw_json_is_object(const char *text) {
    return text != 0 && text[0] == '{';
}

