// Application policy only: RPly owns header parsing, value decoding, and encoding.
#include <cstdio>
#include "rply.h"
#include "rplyfile.h"
#include <array>
#include <cctype>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <limits>
#include <memory>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

using Ply = std::unique_ptr<t_ply_, decltype(&ply_close)>;
using File = std::unique_ptr<FILE, decltype(&fclose)>;
static_assert(sizeof(long) >= 8, "RPly recovery requires 64-bit file offsets and counts");
void check(bool condition, const std::string &message) {
    if (!condition) throw std::runtime_error(message);
}
void errorCallback(p_ply ply, const char *message) {
    void *data = nullptr;
    if (ply) ply_get_ply_user_data(ply, &data, nullptr);
    if (data && static_cast<std::string *>(data)->empty()) *static_cast<std::string *>(data) = message;
}
struct Input {
    std::string error;
    File file;
    Ply ply;
    explicit Input(const char *path) : file(fopen(path, "rb"), fclose), ply(nullptr, ply_close) {
        check(bool(file), "Cannot open input PLY");
        ply.reset(ply_open_from_file(file.get(), errorCallback, 0, &error));
        check(bool(ply), "Cannot initialize PLY reader");
        const bool valid = ply_read_header(ply.get());
        check(valid, "Invalid PLY header: " + error);
    }
};
struct Property { std::string name; e_ply_type type, lengthType, valueType; };
struct Element {
    p_ply_element handle;
    std::string name;
    long declared, complete = 0, target = 0;
    std::vector<Property> properties;
    bool pending = false;
    long lastEnd = 0;
    p_ply input = nullptr, output = nullptr;
    bool writeFailed = false;
};
int scalarWidth(e_ply_type type) {
    static constexpr std::array<int, 8> widths{1, 1, 2, 2, 4, 4, 4, 8};
    check(type >= PLY_INT8 && type < PLY_LIST, "Invalid PLY scalar type");
    return widths[type % widths.size()];
}
long rowWidth(const Element &element) {
    long width = 0;
    for (const auto &property : element.properties) {
        if (property.type == PLY_LIST) return 0;
        width += scalarWidth(property.type);
    }
    return width;
}
std::vector<Element> schema(p_ply ply) {
    std::vector<Element> result;
    std::set<std::string> names;
    p_ply_element handle = nullptr;
    while ((handle = ply_get_next_element(ply, handle))) {
        const char *name; long count;
        ply_get_element_info(handle, &name, &count);
        check(names.insert(name).second, "Duplicate PLY element name");
        Element element{handle, name, count};
        std::set<std::string> propertyNames;
        p_ply_property property = nullptr;
        while ((property = ply_get_next_property(handle, property))) {
            const char *key; e_ply_type type;
            ply_get_property_info(property, &key, &type, nullptr, nullptr);
            e_ply_type length = type, value = type;
            check(propertyNames.insert(key).second, "Duplicate PLY property name");
            if (type == PLY_LIST) {
                ply_get_property_info(property, nullptr, nullptr, &length, &value);
                scalarWidth(value);
            } else scalarWidth(type);
            element.properties.push_back({key, type, length, value});
        }
        check(!element.properties.empty(), "PLY elements must declare properties");
        result.push_back(std::move(element));
    }
    check(!result.empty(), "PLY has no elements");
    return result;
}
int valueCallback(p_ply_argument argument) {
    void *data; long propertyIndex, record, length, index;
    ply_get_argument_user_data(argument, &data, &propertyIndex);
    ply_get_argument_element(argument, nullptr, &record);
    ply_get_argument_property(argument, nullptr, &length, &index);
    auto &element = *static_cast<Element *>(data);
    element.pending = true;
    if (element.output && record < element.target && !ply_write(element.output, ply_get_argument_value(argument))) {
        element.writeFailed = true;
        return 0;
    }
    if (propertyIndex == long(element.properties.size()) - 1 && index == length - 1) {
        ++element.complete;
        element.pending = false;
        element.lastEnd = ply_get_read_position(element.input);
    }
    return 1;
}
void callbacks(p_ply input, std::vector<Element> &elements, bool writing) {
    for (auto &element : elements) {
        element.input = input;
        element.complete = 0;
        element.pending = false;
        for (size_t i = 0; i < element.properties.size(); ++i) {
            // Scanning only needs first/last properties. Writing streams every value.
            if (writing || i == 0 || i + 1 == element.properties.size())
                ply_set_read_cb(input, element.name.c_str(), element.properties[i].name.c_str(),
                    valueCallback, &element, long(i));
        }
    }
}
bool scan(Input &input, std::vector<Element> &elements) {
    // A single element has no ambiguous following block: decode to EOF, including
    // records beyond an underreported count. Multiple elements follow declared bounds.
    if (elements.size() == 1)
        ply_set_element_count(elements.front().handle, std::numeric_limits<long>::max());
    callbacks(input.ply.get(), elements, false);
    bool success = ply_read(input.ply.get());
    check(success || ply_get_read_error(input.ply.get()) == PLY_ERROR_EOF,
        "Cannot recover malformed PLY data: " + input.error);
    check(!ferror(input.file.get()), "I/O error reading PLY");
    return success;
}
void writeRecovered(const char *source, const char *destination, const std::vector<Element> &scanned) {
    Input input(source);
    auto elements = schema(input.ply.get());
    check(elements.size() == scanned.size(), "PLY changed during recovery");
    std::string error;
    Ply output(ply_create(destination, PLY_LITTLE_ENDIAN, errorCallback, 0, &error), ply_close);
    check(bool(output), "Cannot create recovered PLY: " + error);
    for (size_t i = 0; i < elements.size(); ++i) {
        auto &element = elements[i];
        check(element.name == scanned[i].name && element.declared == scanned[i].declared,
            "PLY changed during recovery");
        element.target = scanned[i].complete;
        element.output = output.get();
        check(ply_add_element(output.get(), element.name.c_str(), element.target), "Cannot write PLY element");
        for (const auto &property : element.properties)
            check(ply_add_property(output.get(), property.name.c_str(), property.type,
                property.lengthType, property.valueType), "Cannot write PLY property");
        // Read only the complete prefix. No callbacks from an unfinished record
        // reach the writer, and later element blocks remain in their declared order.
        ply_set_element_count(element.handle, element.target);
    }
    const char *text = nullptr;
    while ((text = ply_get_next_comment(input.ply.get(), text))) check(ply_add_comment(output.get(), text), "Cannot write PLY comment");
    text = nullptr;
    // SplatTransform rejects obj_info lines; preserve their text as PLY comments.
    while ((text = ply_get_next_obj_info(input.ply.get(), text)))
        check(ply_add_comment(output.get(), (std::string("obj_info ") + text).c_str()), "Cannot write PLY metadata");
    check(ply_write_header(output.get()), "Cannot write PLY header");
    callbacks(input.ply.get(), elements, true);
    const bool replayed = ply_read(input.ply.get());
    check(replayed, "Cannot replay complete PLY records: " + input.error + error);
    for (const auto &element : elements)
        check(!element.writeFailed && element.complete == element.target, "Recovered PLY record count changed");
    check(ply_close(output.release()), "Cannot finish recovered PLY");
}
int main(int argc, char **argv) {
    try {
        check(argc == 3, "Usage: recover-ply INPUT OUTPUT");
        Input input(argv[1]);
        auto elements = schema(input.ply.get());
        const auto size = std::filesystem::file_size(argv[1]);
        check(size <= uintmax_t(std::numeric_limits<long>::max()), "PLY exceeds supported file size");
        long headerBytes = ply_get_read_position(input.ply.get());
        bool binary = ply_get_storage_mode(input.ply.get()) != PLY_ASCII;
        bool readAllDeclared = scan(input, elements);
        bool changed = false;
        long lastEnd = headerBytes, declaredVertices = 0, recoveredVertices = 0, vertexWidth = 0;
        long expectedBytes = headerBytes;
        bool fixed = binary;
        for (const auto &element : elements) {
            changed |= element.complete != element.declared || element.pending;
            if (element.complete) lastEnd = element.lastEnd;
            long width = rowWidth(element);
            fixed &= width > 0;
            check(!width || element.declared <= (std::numeric_limits<long>::max() - expectedBytes) / width,
                "PLY counts exceed safe file-size arithmetic");
            expectedBytes += element.declared * width;
            if (element.name == "vertex") {
                declaredVertices = element.declared;
                recoveredVertices = element.complete;
                vertexWidth = width;
            }
        }
        if (binary && uintmax_t(lastEnd) != size) changed = true;
        if (elements.size() > 1 && readAllDeclared && uintmax_t(lastEnd) != size) {
            check(!binary, "Extra bytes after declared PLY blocks; element boundaries are ambiguous");
            check(fseek(input.file.get(), lastEnd, SEEK_SET) == 0, "Cannot inspect PLY tail");
            int byte;
            while ((byte = fgetc(input.file.get())) != EOF)
                check(std::isspace(static_cast<unsigned char>(byte)),
                    "Extra data after declared PLY blocks; element boundaries are ambiguous");
            check(!ferror(input.file.get()), "I/O error reading PLY tail");
        }
        if (!changed) { std::cout << "null\n"; return 0; }
        check(recoveredVertices > 0, "Cannot recover PLY: no complete vertex records remain");
        writeRecovered(argv[1], argv[2], elements);
        std::cout << "{\"kind\":\"ply-record-count\",\"decoder\":" << std::quoted(RPLY_VERSION) << ",\"declaredVertices\":" << declaredVertices
            << ",\"recoveredVertices\":" << recoveredVertices << ",\"discardedBytes\":" << size - lastEnd;
        if (binary && vertexWidth) std::cout << ",\"recordBytes\":" << vertexWidth;
        if (fixed) std::cout << ",\"expectedBytes\":" << expectedBytes;
        std::cout << ",\"elements\":[";
        for (size_t i = 0; i < elements.size(); ++i) {
            if (i) std::cout << ',';
            const auto &element = elements[i];
            std::cout << "{\"name\":" << std::quoted(element.name) << ",\"declared\":" << element.declared
                << ",\"recovered\":" << element.complete << '}';
        }
        std::cout << "]}\n";
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n'; return 1;
    }
}
