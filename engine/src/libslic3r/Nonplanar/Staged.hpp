#pragma once

#include <string>

namespace Slic3r {
class PrintObject;
}

namespace Slic3r::Nonplanar {

struct ConformalResult;

bool staged_requested(const PrintObject &object);
std::string staged_invalid(const PrintObject &object);
std::string build_staged(PrintObject &object, ConformalResult &result);

}
