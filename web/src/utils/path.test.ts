import { describe, it, expect } from "vitest";
import { splitPath, pathBasename, pathParent, isRootPath, pathTail } from "./path.js";

describe("splitPath", () => {
  it("splits Unix paths on /", () => {
    expect(splitPath("/home/user/project")).toEqual(["", "home", "user", "project"]);
  });

  it("splits Windows paths on \\", () => {
    expect(splitPath("C:\\Users\\user\\project")).toEqual(["C:", "Users", "user", "project"]);
  });

  it("splits mixed separators", () => {
    expect(splitPath("C:\\Users/user\\project")).toEqual(["C:", "Users", "user", "project"]);
  });
});

describe("pathBasename", () => {
  it("returns last segment of a Unix path", () => {
    expect(pathBasename("/home/user/project")).toBe("project");
  });

  it("returns last segment of a Windows path", () => {
    expect(pathBasename("C:\\Users\\user\\project")).toBe("project");
  });

  it("handles paths with trailing separator", () => {
    expect(pathBasename("/home/user/project/")).toBe("project");
  });

  it("returns the path itself for a bare name", () => {
    expect(pathBasename("project")).toBe("project");
  });

  it("returns the path for an empty string", () => {
    expect(pathBasename("")).toBe("");
  });
});

describe("pathParent", () => {
  it("returns parent of a Unix path", () => {
    expect(pathParent("/home/user/project")).toBe("/home/user");
  });

  it("returns parent of a Windows path", () => {
    expect(pathParent("C:\\Users\\user\\project")).toBe("C:\\Users\\user");
  });

  it("returns / for a single-level Unix path", () => {
    expect(pathParent("/home")).toBe("/");
  });

  it("returns C:\\ for a single-level Windows path", () => {
    expect(pathParent("C:\\Users")).toBe("C:\\");
  });

  it("handles trailing slashes", () => {
    expect(pathParent("/home/user/")).toBe("/home");
  });

  it("returns the path itself for root /", () => {
    expect(pathParent("/")).toBe("/");
  });
});

describe("isRootPath", () => {
  it("recognizes / as root", () => {
    expect(isRootPath("/")).toBe(true);
  });

  it("recognizes C:\\ as root", () => {
    expect(isRootPath("C:\\")).toBe(true);
  });

  it("recognizes C: as root", () => {
    expect(isRootPath("C:")).toBe(true);
  });

  it("recognizes D:/ as root", () => {
    expect(isRootPath("D:/")).toBe(true);
  });

  it("returns false for non-root paths", () => {
    expect(isRootPath("/home")).toBe(false);
    expect(isRootPath("C:\\Users")).toBe(false);
  });
});

describe("pathTail", () => {
  it("returns last N segments of a Unix path", () => {
    expect(pathTail("/home/user/projects/myapp", 2)).toBe("projects/myapp");
  });

  it("returns last N segments of a Windows path", () => {
    expect(pathTail("C:\\Users\\user\\projects\\myapp", 2)).toBe("projects/myapp");
  });

  it("returns all segments when N exceeds path depth", () => {
    expect(pathTail("/myapp", 5)).toBe("myapp");
  });

  it("returns single segment when N is 1", () => {
    expect(pathTail("/home/user/project", 1)).toBe("project");
  });
});
