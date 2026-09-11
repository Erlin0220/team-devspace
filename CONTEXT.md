# Team DevSpace

Team DevSpace lets one shared ChatGPT workspace app connect each employee to that employee's own local DevSpace instance without depending on an administrator workstation.

## Language

**Employee**:
A company user who installs Team DevSpace and connects the shared ChatGPT workspace app to an enrolled computer.

**Device**:
One employee computer enrolled in Team DevSpace.
_Avoid_: Node, endpoint, machine instance

**Access Key**:
The employee-facing secret used to enroll and connect one device. In the MVP, one Access Key binds to exactly one Device and can be revoked or reset by an Administrator.
_Avoid_: Owner Token, Tunnel Token, Device Secret

**Enrollment**:
The first successful binding of an Access Key to a Device.
_Avoid_: Login, install

**Device Binding**:
The association between one Access Key and one enrolled Device. Reinstalling on the same Device preserves the binding; moving the key to a different Device requires an Administrator reset.
_Avoid_: Session

**Current Project Root**:
The one local project directory that Team DevSpace exposes for development on a Device. An Employee may replace it with another local directory. Upstream DevSpace still receives its native `allowedRoots` array internally as `[Current Project Root]`; multi-root selection is not a Team DevSpace product concept.
_Avoid_: Allowed Roots as a user-facing collection, cross-device path mapping

**Connection**:
An authenticated ChatGPT-to-Device path using a valid Access Key. One Access Key may support multiple concurrent or reconnecting ChatGPT sessions while remaining bound to one Device.
_Avoid_: Device Binding, Tunnel

**Administrator**:
The person who issues, revokes, and resets employee Access Keys and Device Bindings.

**Revocation**:
Disabling an Access Key and its Device connectivity so future ChatGPT requests can no longer reach that Device.

**Team DevSpace Release**:
A tested distributable version of Team DevSpace that pins one chosen upstream DevSpace version. Employee installs do not automatically follow upstream releases.
_Avoid_: Upstream DevSpace release
