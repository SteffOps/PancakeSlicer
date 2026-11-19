#include "Staged.hpp"

#include "ConformalShells.hpp"
#include "Multiplanar.hpp"
#include "PatchTools.hpp"
#include "libslic3r/AABBTreeIndirect.hpp"
#include "libslic3r/BoundingBox.hpp"
#include "libslic3r/ExPolygon.hpp"
#include "libslic3r/Exception.hpp"
#include "libslic3r/ExtrusionEntity.hpp"
#include "libslic3r/ExtrusionEntityCollection.hpp"
#include "libslic3r/Geometry.hpp"
#include "libslic3r/I18N.hpp"
#include "libslic3r/Layer.hpp"
#include "libslic3r/LocalesUtils.hpp"
#include "libslic3r/MeshBoolean.hpp"
#include "libslic3r/Model.hpp"
#include "libslic3r/Point.hpp"
#include "libslic3r/Print.hpp"
#include "libslic3r/PrintConfig.hpp"
#include "libslic3r/TriangleMesh.hpp"
#include "libslic3r/format.hpp"
#include "libslic3r/libslic3r.h"

#include <Eigen/Geometry>
#include <boost/log/trivial.hpp>

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <memory>
#include <limits>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace Slic3r::Nonplanar {

namespace {

struct Part
{
    std::string          name;
    int                  stage      = 1;
    int                  copies     = 1;
    StagedLayerStyle     style      = StagedLayerStyle::Flat;
    StagedTool           tool       = StagedTool::Follow;
    double               tilt       = 0.;
    Vec3d                point { Vec3d::Zero() };
    Vec3d                dir { Vec3d::UnitZ() };
    Vec3d                start { Vec3d::UnitZ() };
    double               turn       = 0.5 * M_PI;
    double               half_angle = 0.25 * M_PI;
    double               radius     = 0.;
    indexed_triangle_set mesh;
};

std::vector<Part> staged_parts(const PrintObject &object)
{
    std::vector<Part>  parts;
    const ModelObject &model = *object.model_object();
    for (const ModelVolume *volume : model.volumes) {
        if (!volume->is_model_part())
            continue;
        DynamicPrintConfig config = object.print()->full_print_config();
        config.apply(model.config.get(), true);
        config.apply(volume->config.get(), true);
        Part part;
        part.name       = volume->name;
        part.stage      = config.opt_int("staged_stage");
        part.copies     = std::max(1, config.opt_int("staged_copies"));
        part.style      = config.option<ConfigOptionEnum<StagedLayerStyle>>("staged_layer_style")->value;
        part.tool       = config.option<ConfigOptionEnum<StagedTool>>("staged_tool")->value;
        part.tilt       = Geometry::deg2rad(config.opt_float("staged_tool_tilt"));
        part.point      = config.option<ConfigOptionPoint3>("staged_axis_point")->value;
        part.dir        = config.option<ConfigOptionPoint3>("staged_axis_dir")->value;
        part.start      = config.option<ConfigOptionPoint3>("staged_hinge_start")->value;
        part.turn       = Geometry::deg2rad(config.opt_float("staged_hinge_angle"));
        part.half_angle = Geometry::deg2rad(config.opt_float("staged_cone_half_angle"));
        part.radius     = config.opt_float("staged_cone_radius");
        part.mesh       = volume->mesh().its;
        const Transform3d matrix = volume->get_matrix();
        for (stl_vertex &v : part.mesh.vertices)
            v = (matrix * v.cast<double>()).cast<float>();
        if (matrix.matrix().block<3, 3>(0, 0).determinant() < 0.)
            for (stl_triangle_vertex_indices &f : part.mesh.indices)
                std::swap(f[1], f[2]);
        its_merge_vertices(part.mesh);
        parts.push_back(std::move(part));
    }
    std::stable_sort(parts.begin(), parts.end(), [](const Part &a, const Part &b) { return a.stage < b.stage; });
    return parts;
}

Matrix3d copy_rotation(int copy, int copies)
{
    return Eigen::AngleAxisd(2. * M_PI * double(copy) / double(copies), Vec3d::UnitZ()).toRotationMatrix();
}

indexed_triangle_set refine(indexed_triangle_set mesh, double max_edge)
{
    const float limit = float(max_edge * max_edge);
    auto        key   = [](int a, int b) {
        if (a > b)
            std::swap(a, b);
        return (uint64_t(uint32_t(a)) << 32) | uint32_t(b);
    };
    for (int pass = 0; pass < 24; ++pass) {
        std::unordered_map<uint64_t, int> mid;
        for (const stl_triangle_vertex_indices &f : mesh.indices)
            for (int e = 0; e < 3; ++e) {
                const int a = f[e], b = f[(e + 1) % 3];
                if ((mesh.vertices[a] - mesh.vertices[b]).squaredNorm() > limit && mid.find(key(a, b)) == mid.end()) {
                    const stl_vertex m = 0.5f * (mesh.vertices[a] + mesh.vertices[b]);
                    mid.emplace(key(a, b), int(mesh.vertices.size()));
                    mesh.vertices.push_back(m);
                }
            }
        if (mid.empty())
            break;
        std::vector<stl_triangle_vertex_indices> out;
        out.reserve(mesh.indices.size() * 3);
        for (const stl_triangle_vertex_indices &f : mesh.indices) {
            int m[3];
            int n = 0;
            for (int e = 0; e < 3; ++e) {
                const auto it = mid.find(key(f[e], f[(e + 1) % 3]));
                m[e]          = it == mid.end() ? -1 : it->second;
                n += m[e] >= 0 ? 1 : 0;
            }
            if (n == 0)
                out.push_back(f);
            else if (n == 3) {
                out.emplace_back(f[0], m[0], m[2]);
                out.emplace_back(m[0], f[1], m[1]);
                out.emplace_back(m[2], m[1], f[2]);
                out.emplace_back(m[0], m[1], m[2]);
            } else if (n == 1) {
                const int e = m[0] >= 0 ? 0 : m[1] >= 0 ? 1 : 2;
                const int a = f[e], b = f[(e + 1) % 3], c = f[(e + 2) % 3];
                out.emplace_back(a, m[e], c);
                out.emplace_back(m[e], b, c);
            } else {
                const int e   = m[0] < 0 ? 0 : m[1] < 0 ? 1 : 2;
                const int a   = f[e], b = f[(e + 1) % 3], c = f[(e + 2) % 3];
                const int mbc = m[(e + 1) % 3], mca = m[(e + 2) % 3];
                out.emplace_back(a, b, mbc);
                out.emplace_back(a, mbc, mca);
                out.emplace_back(mca, mbc, c);
            }
        }
        mesh.indices = std::move(out);
    }
    return mesh;
}

double mesh_volume(const indexed_triangle_set &mesh)
{
    double v = 0.;
    for (const stl_triangle_vertex_indices &f : mesh.indices)
        v += mesh.vertices[f[0]].cast<double>().dot(mesh.vertices[f[1]].cast<double>().cross(mesh.vertices[f[2]].cast<double>()));
    return v / 6.;
}

double winding(const indexed_triangle_set &mesh, const Vec3d &p)
{
    double total = 0.;
    for (const stl_triangle_vertex_indices &f : mesh.indices) {
        const Vec3d  a = mesh.vertices[f[0]].cast<double>() - p, b = mesh.vertices[f[1]].cast<double>() - p, c = mesh.vertices[f[2]].cast<double>() - p;
        const double la = a.norm(), lb = b.norm(), lc = c.norm();
        total += 2. * std::atan2(a.dot(b.cross(c)), la * lb * lc + a.dot(b) * lc + b.dot(c) * la + c.dot(a) * lb);
    }
    return total / (4. * M_PI);
}

size_t buried_faces(const indexed_triangle_set &mesh, const indexed_triangle_set &solid)
{
    BoundingBoxf3 box = bounding_box(solid);
    size_t        n   = 0;
    for (const stl_triangle_vertex_indices &f : mesh.indices) {
        const Vec3d a = mesh.vertices[f[0]].cast<double>(), b = mesh.vertices[f[1]].cast<double>(), c = mesh.vertices[f[2]].cast<double>();
        const Vec3d normal = (b - a).cross(c - a);
        if (normal.norm() < 1e-12)
            continue;
        const Vec3d p = (a + b + c) / 3. - 0.05 * normal.normalized();
        if (box.contains(p) && winding(solid, p) > 0.9 && winding(mesh, p) > 0.9)
            ++n;
    }
    return n;
}

double wrap_angle(double a, double center)
{
    while (a < center - M_PI)
        a += 2. * M_PI;
    while (a >= center + M_PI)
        a -= 2. * M_PI;
    return a;
}

class LayerMap
{
public:
    LayerMap(const Part &part, const indexed_triangle_set &piece) : m_style(part.style), m_c(part.point)
    {
        if (!(part.dir.norm() > 1e-9))
            throw Slic3r::SlicingError(Slic3r::format(_u8L("Staged regions: part %1% has no axis direction."), part.name));
        m_a = part.dir.normalized();
        if (m_style == StagedLayerStyle::Hinge) {
            const Vec3d n0 = part.start - part.start.dot(m_a) * m_a;
            if (n0.norm() < 1e-6)
                throw Slic3r::SlicingError(Slic3r::format(_u8L("Staged regions: the hinge start normal of part %1% lies along its hinge axis."), part.name));
            m_v   = n0.normalized();
            m_u   = m_v.cross(m_a);
            m_cut = 0.5 * part.turn;
            for (const stl_vertex &v : piece.vertices) {
                const Vec3d d = v.cast<double>() - m_c;
                m_ref         = std::max(m_ref, std::hypot(d.dot(m_u), d.dot(m_v)));
            }
            if (!(m_ref > EPSILON))
                throw Slic3r::SlicingError(Slic3r::format(_u8L("Staged regions: part %1% lies on its hinge axis."), part.name));
        } else {
            m_u = m_a.unitOrthogonal();
            m_v = m_a.cross(m_u);
        }
        if (m_style == StagedLayerStyle::GrowCone) {
            m_beta     = part.half_angle;
            m_r0       = part.radius;
            m_cylinder = std::sin(m_beta) < 1e-6;
            Vec3d sum  = Vec3d::Zero();
            for (const stl_vertex &v : piece.vertices) {
                const Vec3d d = v.cast<double>() - m_c;
                const Vec3d w = d - d.dot(m_a) * m_a;
                if (w.norm() > EPSILON)
                    sum += w.normalized();
            }
            m_cut = std::atan2(sum.dot(m_v), sum.dot(m_u));
        }
        if (!piece.vertices.empty()) {
            Vec3d center = Vec3d::Zero();
            for (const stl_vertex &v : piece.vertices)
                center += v.cast<double>();
            center /= double(piece.vertices.size());
            Vec3d probe = piece.vertices.front().cast<double>();
            probe       = probe + 0.01 * (center - probe);
            Matrix3d jacobian;
            for (int k = 0; k < 3; ++k)
                jacobian.col(k) = (to_layer(probe + 1e-4 * Vec3d::Unit(k)) - to_layer(probe - 1e-4 * Vec3d::Unit(k))) / 2e-4;
            m_flip = jacobian.determinant() < 0.;
        }
    }

    Vec3d to_layer(const Vec3d &p) const
    {
        const Vec3d d = p - m_c;
        Vec3d       q;
        if (m_style == StagedLayerStyle::Flat)
            q = Vec3d(d.dot(m_u), d.dot(m_v), d.dot(m_a));
        else if (m_style == StagedLayerStyle::Hinge) {
            const double x = d.dot(m_u), y = d.dot(m_v);
            q = Vec3d(d.dot(m_a), std::hypot(x, y), wrap_angle(std::atan2(y, x), m_cut) * m_ref);
        } else {
            const double s   = d.dot(m_a);
            const Vec3d  w   = d - s * m_a;
            const double r   = w.norm();
            const double phi = wrap_angle(std::atan2(w.dot(m_v), w.dot(m_u)), m_cut) - m_cut;
            const double cb = std::cos(m_beta), sb = std::sin(m_beta);
            const double h = (r - m_r0) * cb + s * sb;
            if (m_cylinder)
                q = Vec3d(phi * r, -(r - m_r0) * sb + s * cb, h);
            else {
                const double l = r / sb, psi = phi * sb;
                q = Vec3d(l * std::cos(psi), l * std::sin(psi), h);
            }
        }
        if (m_flip)
            q.x() = -q.x();
        return q;
    }

    Vec3d to_part(Vec3d q) const
    {
        if (m_flip)
            q.x() = -q.x();
        if (m_style == StagedLayerStyle::Flat)
            return m_c + q.x() * m_u + q.y() * m_v + q.z() * m_a;
        if (m_style == StagedLayerStyle::Hinge) {
            const double theta = q.z() / m_ref;
            return m_c + q.x() * m_a + q.y() * (std::cos(theta) * m_u + std::sin(theta) * m_v);
        }
        const double cb = std::cos(m_beta), sb = std::sin(m_beta), h = q.z();
        double       r, phi, g;
        if (m_cylinder) {
            r   = m_r0 + h;
            phi = r > EPSILON ? q.x() / r : 0.;
            g   = q.y();
        } else {
            r   = std::hypot(q.x(), q.y()) * sb;
            phi = std::atan2(q.y(), q.x()) / sb;
            g   = (m_r0 + h * cb - r) / sb;
        }
        const double s = h * sb + g * cb;
        phi += m_cut;
        return m_c + s * m_a + r * (std::cos(phi) * m_u + std::sin(phi) * m_v);
    }

    Vec3d normal(const Vec3d &p) const
    {
        const Vec3d d = p - m_c;
        if (m_style == StagedLayerStyle::Flat)
            return m_a;
        const double phi = std::atan2(d.dot(m_v), d.dot(m_u));
        if (m_style == StagedLayerStyle::Hinge)
            return -std::sin(phi) * m_u + std::cos(phi) * m_v;
        return std::cos(m_beta) * (std::cos(phi) * m_u + std::sin(phi) * m_v) + std::sin(m_beta) * m_a;
    }

    double thickness(const Vec3d &p) const
    {
        if (m_style != StagedLayerStyle::Hinge)
            return 1.;
        const Vec3d d = p - m_c;
        return std::hypot(d.dot(m_u), d.dot(m_v)) / m_ref;
    }

private:
    StagedLayerStyle m_style;
    Vec3d            m_c, m_a, m_u, m_v;
    double           m_ref      = 0.;
    double           m_cut      = 0.;
    double           m_beta     = 0.;
    double           m_r0       = 0.;
    bool             m_cylinder = false;
    bool             m_flip     = false;
};

struct StagedPath
{
    ExtrusionPath       proto;
    std::vector<Vec3d>  points;
    std::vector<Vec3d>  axes;
    std::vector<float>  heights;
    std::vector<float>  widths;
    Vec3d               first { Vec3d::Zero() };
    Vec3d               last { Vec3d::Zero() };
    std::vector<Vec3d>  travel;
    std::vector<Vec3d>  travel_axes;
};

struct RawPath
{
    ExtrusionPath      proto;
    std::vector<Vec3d> points;
    std::vector<float> widths;
};

using Level = std::vector<StagedPath>;

struct Printed
{
    std::unique_ptr<LayerMap> map;
    int                       copies = 1;
    std::vector<double>       bottom, top;
    std::vector<ExPolygons>   slices;
    std::vector<BoundingBox>  boxes;

    bool contains(const Vec3d &p) const
    {
        for (int k = 0; k < copies; ++k) {
            const Vec3d  q = map->to_layer(copy_rotation(k, copies).transpose() * p);
            const size_t i = size_t(std::upper_bound(top.begin(), top.end(), q.z()) - top.begin());
            if (i >= top.size() || q.z() < bottom[i])
                continue;
            const Point pt = Point::new_scale(q.x(), q.y());
            if (!boxes[i].contains(pt))
                continue;
            for (const ExPolygon &island : slices[i])
                if (island.contains(pt))
                    return true;
        }
        return false;
    }
};

Vec3d tool_axis(const Part &part, const Vec3d &normal, const Vec3d &p)
{
    if (part.tool == StagedTool::Follow)
        return normal;
    Vec2d horizontal = normal.head<2>();
    if (horizontal.norm() < 1e-6)
        horizontal = p.head<2>();
    const double azimuth = horizontal.norm() < 1e-9 ? 0. : std::atan2(horizontal.y(), horizontal.x());
    return Vec3d(std::sin(part.tilt) * std::cos(azimuth), std::sin(part.tilt) * std::sin(azimuth), std::cos(part.tilt));
}

void resample(RawPath &path, double shortest, double longest)
{
    std::vector<Vec3d> points { path.points.front() };
    std::vector<float> widths { path.widths.front() };
    for (size_t i = 1; i < path.points.size(); ++i) {
        const bool end = i + 1 == path.points.size();
        if (!end && (path.points[i] - points.back()).norm() < shortest)
            continue;
        if (end && points.size() > 1 && (path.points[i] - points.back()).norm() < shortest) {
            points.pop_back();
            widths.pop_back();
        }
        points.push_back(path.points[i]);
        widths.push_back(path.widths[i]);
    }
    path.points.clear();
    path.widths.clear();
    for (size_t i = 0; i < points.size(); ++i) {
        if (i > 0) {
            const int n = std::max(1, int(std::ceil((points[i] - points[i - 1]).norm() / longest)));
            for (int k = 1; k < n; ++k) {
                const double t = double(k) / n;
                path.points.push_back(points[i - 1] + (points[i] - points[i - 1]) * t);
                path.widths.push_back(float(widths[i - 1] + (widths[i] - widths[i - 1]) * t));
            }
        }
        path.points.push_back(points[i]);
        path.widths.push_back(widths[i]);
    }
}

void route(const LayerMap &map, const Part &part, Vec3d from, const Vec3d &to, double hop, std::vector<Vec3d> &points,
           std::vector<Vec3d> &axes)
{
    from.z() = to.z();
    const int n = std::max(1, int(std::ceil((to - from).norm())));
    for (int k = 0; k <= n; ++k) {
        const Vec3d p      = map.to_part(from + (to - from) * (double(k) / n));
        const Vec3d normal = map.normal(p);
        points.push_back(p + hop * normal);
        axes.push_back(tool_axis(part, normal, p));
    }
}

std::vector<Level> slice_part(const PrintObject &object, const Part &part, const indexed_triangle_set &piece, const LayerMap &map,
                              const indexed_triangle_set &parent, const std::vector<const Printed *> &below, const DynamicPrintConfig &config,
                              double hop, Printed &printed, double &thin, double &thick)
{
    const auto parent_tree = AABBTreeIndirect::build_aabb_tree_over_indexed_triangle_set(parent.vertices, parent.indices);
    auto       on_parent   = [&](const Vec3d &q) {
        return std::any_of(below.begin(), below.end(), [&q](const Printed *p) { return p->contains(q); });
    };
    auto contact = [&](const Vec3d &p, const Vec3d &normal, double t) {
        if (parent.indices.empty())
            return t;
        igl::Hit<float> hit;
        if (!AABBTreeIndirect::intersect_ray_first_hit(parent.vertices, parent.indices, parent_tree, p, Vec3d(-normal), hit))
            return t;
        const double d = double(hit.t);
        if (d <= 0.5 * t || d > 1.5 * t)
            return t;
        for (double s = 0.3 * t; s <= 2. * t; s += 0.01)
            if (on_parent(p - s * normal))
                return s;
        return d;
    };
    indexed_triangle_set mapped = part.style == StagedLayerStyle::Flat ? piece : refine(piece, 1.);
    for (stl_vertex &v : mapped.vertices)
        v = map.to_layer(v.cast<double>()).cast<float>();
    float base = std::numeric_limits<float>::max();
    for (const stl_vertex &v : mapped.vertices)
        base = std::min(base, v.z());

    Model        model;
    ModelObject *model_object = model.add_object();
    model_object->name        = object.model_object()->name + " " + part.name;
    model_object->add_volume(TriangleMesh(std::move(mapped)));
    model_object->add_instance();
    Print print;
    try {
        print.apply(model, config);
        print.set_status_silent();
        print.process();
    } catch (const SlicingErrors &errors) {
        throw Slic3r::SlicingError(Slic3r::format(_u8L("Staged regions: slicing part %1% failed: %2%"), part.name, print.slicing_errors_message(errors)));
    } catch (const std::exception &ex) {
        throw Slic3r::SlicingError(Slic3r::format(_u8L("Staged regions: slicing part %1% failed: %2%"), part.name, ex.what()));
    }
    std::vector<Level> levels;
    if (print.objects().empty())
        return levels;
    const PrintObject &sliced = *print.objects().front();
    const Vec2d        center = unscale(sliced.center_offset());
    for (const Layer *layer : sliced.layers()) {
        ExPolygons islands = layer->lslices;
        for (ExPolygon &island : islands)
            island.translate(sliced.center_offset());
        printed.bottom.push_back(layer->print_z - layer->height + base);
        printed.top.push_back(layer->print_z + base);
        printed.boxes.push_back(get_extents(islands));
        printed.slices.push_back(std::move(islands));
    }
    for (const Layer *layer : sliced.layers()) {
        throw_if_canceled(object);
        std::vector<const ExtrusionPath *> paths;
        for (const LayerRegion *region : layer->regions()) {
            collect_paths(&region->perimeters, paths);
            collect_paths(&region->fills, paths);
        }
        std::vector<RawPath> raw;
        for (const ExtrusionPath *path : paths) {
            const Points3 &pts = path->polyline.points;
            if (pts.size() < 2)
                continue;
            std::vector<Vec3d> qs;
            for (const Point3 &pt : pts)
                qs.emplace_back(unscale<double>(pt.x()) + center.x(), unscale<double>(pt.y()) + center.y(), layer->print_z + base);
            if (!raw.empty() && raw.back().proto.role() == path->role() && (raw.back().points.back() - qs.front()).norm() < 0.01) {
                raw.back().points.insert(raw.back().points.end(), qs.begin() + 1, qs.end());
                raw.back().widths.insert(raw.back().widths.end(), qs.size() - 1, path->width);
            } else
                raw.push_back({ ExtrusionPath(path->role(), path->mm3_per_mm, path->width, path->height), std::move(qs),
                                std::vector<float>(pts.size(), path->width) });
        }
        Level level;
        for (RawPath &path : raw) {
            resample(path, 0.25, 1.);
            if (path.points.size() < 2)
                continue;
            StagedPath out { path.proto, {}, {}, {}, {}, path.points.front(), path.points.back(), {}, {} };
            out.points.reserve(path.points.size());
            for (size_t k = 0; k < path.points.size(); ++k) {
                const Vec3d  p      = map.to_part(path.points[k]);
                const Vec3d  normal = map.normal(p);
                const double t      = contact(p, normal, path.proto.height * map.thickness(p));
                out.points.push_back(p);
                out.axes.push_back(tool_axis(part, normal, p));
                out.heights.push_back(float(t));
                out.widths.push_back(path.widths[k]);
                thin  = std::min(thin, t);
                thick = std::max(thick, t);
            }
            if (!level.empty())
                route(map, part, level.back().last, out.first, hop, out.travel, out.travel_axes);
            level.push_back(std::move(out));
        }
        if (!level.empty())
            levels.push_back(std::move(level));
    }
    return levels;
}

}

bool staged_requested(const PrintObject &object) { return object.config().nonplanar_mode.value == NonplanarMode::Staged; }

std::string staged_invalid(const PrintObject &object)
{
    if (object.print()->config().nonplanar_kinematics.value == RotaryLayout::None)
        return _u8L("Staged regions need a printer with rotary axes.");
    const ModelObject &model = *object.model_object();
    bool               copies = false;
    for (const ModelVolume *volume : model.volumes)
        if (volume->is_model_part() && volume->config.has("staged_copies") && volume->config.opt_int("staged_copies") > 1)
            copies = true;
    if (copies) {
        const BoundingBoxf bed(object.print()->config().printable_area.values);
        for (const ModelInstance *instance : model.instances) {
            const Vec3d rotation = instance->get_rotation();
            if ((instance->get_offset().head<2>() - bed.center()).norm() > 0.5 || std::abs(rotation.x()) > 1e-6 || std::abs(rotation.y()) > 1e-6)
                return _u8L("Staged regions: copies turn about the assembly's vertical axis, so the assembly origin has to sit on the "
                            "turntable axis at the plate centre, upright.");
        }
    }
    return {};
}

std::string build_staged(PrintObject &object, ConformalResult &result)
{
    std::string report;
    if (object.layers().empty())
        return report;
    if (const std::string why = staged_invalid(object); !why.empty())
        throw Slic3r::SlicingError(why);
    std::vector<Part> parts = staged_parts(object);
    if (parts.empty())
        return report;
    const double nozzle = object.print()->config().nozzle_diameter.get_at(0);
    const double h      = std::min(object.config().layer_height.value, 0.75 * nozzle);
    const double hop    = std::max(1., object.print()->config().z_hop.get_at(0));
    DynamicPrintConfig config = chunk_print_config(object);
    config.set_deserialize_strict("layer_height", float_to_string_decimal_point(h));
    config.set_deserialize_strict("initial_layer_print_height", float_to_string_decimal_point(h));

    std::vector<std::vector<Level>> levels(parts.size());
    std::vector<Printed>            printed(parts.size());
    for (size_t i = 0; i < parts.size(); ++i) {
        throw_if_canceled(object);
        const Part          &part  = parts[i];
        indexed_triangle_set piece = part.mesh;
        const double         whole = mesh_volume(piece);
        BoundingBoxf3        box   = bounding_box(piece);
        box.offset(1.);
        indexed_triangle_set         parent;
        std::vector<const Printed *> below;
        for (size_t j = 0; j < parts.size() && parts[j].stage < part.stage; ++j) {
            below.push_back(&printed[j]);
            for (int k = 0; k < parts[j].copies; ++k) {
                indexed_triangle_set earlier = parts[j].mesh;
                const Matrix3d       rot     = copy_rotation(k, parts[j].copies);
                for (stl_vertex &v : earlier.vertices)
                    v = (rot * v.cast<double>()).cast<float>();
                if (!bounding_box(earlier).intersects(box))
                    continue;
                its_merge(parent, earlier);
                try {
                    MeshBoolean::cgal::minus(piece, earlier);
                } catch (const std::exception &ex) {
                    if (buried_faces(piece, earlier) == 0 && buried_faces(earlier, piece) == 0)
                        continue;
                    throw Slic3r::SlicingError(Slic3r::format(_u8L("Staged regions: could not take part %1% out of part %2% (%3%). Both "
                                                                   "parts must be closed solids."),
                                                              parts[j].name, part.name, ex.what()));
                }
            }
        }
        if (piece.indices.empty())
            throw Slic3r::SlicingError(Slic3r::format(_u8L("Staged regions: part %1% lies inside earlier stages."), part.name));
        printed[i].map    = std::make_unique<LayerMap>(part, piece);
        printed[i].copies = part.copies;
        const LayerMap &map = *printed[i].map;
        double         thin = std::numeric_limits<double>::infinity(), thick = 0.;
        levels[i] = slice_part(object, part, piece, map, parent, below, config, hop, printed[i], thin, thick);
        const std::string line = Slic3r::format(_u8L("%1%: stage %2%, %3% levels x %4% copies, %5$.3f to %6$.3f mm thick"), part.name, part.stage,
                                                levels[i].size(), part.copies, thin, thick);
        report += (report.empty() ? std::string() : std::string("; ")) + line;
        BOOST_LOG_TRIVIAL(warning) << "Staged " << object.model_object()->name << " " << line << ", " << mesh_volume(piece) << " of " << whole
                                   << " mm3 left after earlier stages";
    }

    Layer       *first = object.layers().front();
    Layer       *upper = object.layers().back();
    const double raft  = first->print_z - (first->slice_z + 0.5 * first->height);
    Transform3d  frame = object.instances().front().model_instance->get_matrix();
    frame.translation() = Vec3d(-unscale<double>(object.center_offset().x()), -unscale<double>(object.center_offset().y()),
                                object.instances().front().model_instance->get_offset().z());
    const Matrix3d linear = frame.linear();

    struct Entry
    {
        size_t part;
        int    copy;
        double azimuth;
    };
    std::vector<int> first_ids, upper_ids;
    std::pair<size_t, int> previous { size_t(-1), -1 };
    for (size_t begin = 0; begin < parts.size();) {
        size_t last = begin;
        while (last < parts.size() && parts[last].stage == parts[begin].stage)
            ++last;
        const bool first_stage = begin == 0;
        std::vector<Entry> entries;
        size_t             rounds = 0;
        for (size_t i = begin; i < last; ++i) {
            rounds = std::max(rounds, levels[i].size());
            Vec3d centroid = Vec3d::Zero();
            for (const stl_vertex &v : parts[i].mesh.vertices)
                centroid += v.cast<double>();
            centroid /= double(std::max<size_t>(1, parts[i].mesh.vertices.size()));
            for (int k = 0; k < parts[i].copies; ++k) {
                const Vec3d c = copy_rotation(k, parts[i].copies) * centroid;
                entries.push_back({ i, k, c.head<2>().norm() > 1e-6 ? std::atan2(c.y(), c.x()) : 0. });
            }
        }
        std::stable_sort(entries.begin(), entries.end(), [](const Entry &a, const Entry &b) { return a.azimuth < b.azimuth; });
        for (size_t round = 0; round < rounds; ++round) {
            bool opened = false;
            for (size_t e = 0; e < entries.size(); ++e) {
                const Entry &entry = entries[round % 2 == 0 ? e : entries.size() - 1 - e];
                if (round >= levels[entry.part].size())
                    continue;
                throw_if_canceled(object);
                const Matrix3d rot = copy_rotation(entry.copy, parts[entry.part].copies);
                ConformalPatch patch;
                patch.id           = int(result.patches.size());
                patch.kind         = PatchKind::Chunk;
                patch.shell_height = h;
                const bool on_plate = first != upper && first_stage && round == 0;
                Layer     *host     = on_plate ? first : upper;
                patch.host_layer   = on_plate ? 0 : object.layers().size() - 1;
                patch.region_id    = 0;
                patch.z_min        = std::numeric_limits<double>::infinity();
                patch.z_max        = -std::numeric_limits<double>::infinity();
                patch.staged_piece = int(entry.part) * 1000 + entry.copy;
                patch.staged_level = int(round);
                patch.staged_round = !opened;
                patch.staged_label = parts[entry.part].name + (parts[entry.part].copies > 1 ? " copy " + std::to_string(entry.copy + 1) : std::string());
                opened             = true;
                ExtrusionEntityCollection shell;
                const Level &level = levels[entry.part][round];
                const bool   local = previous == std::make_pair(entry.part, entry.copy) && round > 0 && !levels[entry.part][round - 1].empty();
                previous           = { entry.part, entry.copy };
                auto place = [&](const Vec3d &p) {
                    const Vec3d tip = frame * (rot * p);
                    return Point3::new_scale(tip.x(), tip.y(), tip.z() + raft - host->print_z);
                };
                auto turn = [&](const Vec3d &a) { return Vec3f((linear * (rot * a)).normalized().cast<float>()); };
                for (size_t j = 0; j < level.size(); ++j) {
                    const StagedPath  &path = level[j];
                    Polyline3          polyline;
                    std::vector<Vec3f> axes;
                    std::vector<float> heights = path.heights;
                    polyline.points.reserve(path.points.size());
                    axes.reserve(path.points.size());
                    for (size_t i = 0; i < path.points.size(); ++i) {
                        const Vec3d tip = frame * (rot * path.points[i]);
                        patch.z_min     = std::min(patch.z_min, tip.z() + raft);
                        patch.z_max     = std::max(patch.z_max, tip.z() + raft);
                        polyline.points.push_back(place(path.points[i]));
                        axes.push_back(turn(path.axes[i]));
                    }
                    auto *conformal = new ExtrusionPathConformal(std::move(polyline), path.proto, std::move(heights), std::move(axes));
                    conformal->bead_width      = path.widths;
                    conformal->preserve_points = true;
                    std::vector<Vec3d> travel = path.travel, travel_axes = path.travel_axes;
                    if (j == 0 && local)
                        route(*printed[entry.part].map, parts[entry.part], levels[entry.part][round - 1].back().last, path.first, hop, travel,
                              travel_axes);
                    for (size_t i = 0; i < travel.size(); ++i) {
                        conformal->entry_travel.points.push_back(place(travel[i]));
                        conformal->entry_tool_axis.push_back(turn(travel_axes[i]));
                    }
                    shell.entities.push_back(conformal);
                }
                if (shell.entities.empty())
                    continue;
                patch.shell_paths.push_back(std::move(shell));
                patch.shells = 1;
                (on_plate ? first_ids : upper_ids).push_back(patch.id);
                result.patches.push_back(std::move(patch));
            }
        }
        begin = last;
    }
    if (!result.patches.empty())
        result.patches.back().staged_last = true;
    first->conformal_patches_after.insert(first->conformal_patches_after.end(), first_ids.begin(), first_ids.end());
    upper->conformal_patches_after.insert(upper->conformal_patches_after.end(), upper_ids.begin(), upper_ids.end());
    return report;
}

}
