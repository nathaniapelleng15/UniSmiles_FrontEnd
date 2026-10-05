# Uni-Smiles Backend API Documentation

> **Base URL:** `http://localhost:<PORT>/api/v1`
>
> All request and response bodies use `application/json` unless stated otherwise.

---

## Table of Contents

- [Authentication Overview](#authentication-overview)
- [Error Response Format](#error-response-format)
- [1. AUTH API — `/api/v1/auth`](#1-auth-api--apiv1auth)
  - [POST /api/v1/auth/login](#post-apiv1authlogin)
  - [POST /api/v1/auth/register](#post-apiv1authregister)
  - [GET /api/v1/auth/me](#get-apiv1authme)
- [2. PUBLIC API — `/api/v1/public`](#2-public-api--apiv1public)
  - [GET /api/v1/public/settings](#get-apiv1publicsettings)
- [3. KIOSK API — `/api/v1/kiosk`](#3-kiosk-api--apiv1kiosk)
  - [GET /api/v1/kiosk/payments](#get-apiv1kioskpayments)
  - [POST /api/v1/kiosk/sessions/start](#post-apiv1kiosksessionsstart)
  - [POST /api/v1/kiosk/sessions/:session_code/payment](#post-apiv1kiosksessionssession_codepayment)
  - [POST /api/v1/kiosk/sessions/:session_code/photos](#post-apiv1kiosksessionssession_codephotos)
  - [PUT /api/v1/kiosk/sessions/:session_code/complete](#put-apiv1kiosksessionssession_codecomplete)
- [4. ADMIN API — `/api/v1/admin`](#4-admin-api--apiv1admin)
  - [GET /api/v1/admin/dashboard](#get-apiv1admindashboard)
  - [GET /api/v1/admin/kiosks](#get-apiv1adminkiosks)
  - [POST /api/v1/admin/kiosks](#post-apiv1adminkiosks)
  - [GET /api/v1/admin/payment-profile](#get-apiv1adminpayment-profile)
  - [POST /api/v1/admin/payment-profile/qris](#post-apiv1adminpayment-profileqris)
  - [GET /api/v1/admin/templates](#get-apiv1admintemplates)
  - [POST /api/v1/admin/templates](#post-apiv1admintemplates)

---

## Authentication Overview

The API uses **two** authentication mechanisms depending on the consumer:

| Consumer | Mechanism | Header |
|---|---|---|
| **Admin Dashboard** | JWT Bearer Token | `Authorization: Bearer <token>` |
| **Kiosk Client** | API Key | `x-api-key: <kiosk_api_key>` |

- **JWT tokens** are obtained via `POST /api/v1/auth/login` and expire based on the `JWT_EXPIRES_IN` environment variable (default: `1d`).
- **API keys** are generated when a kiosk is created via `POST /api/v1/admin/kiosks` and are permanently tied to that kiosk.

---

## Error Response Format

All error responses follow this consistent structure:

```json
{
  "success": false,
  "message": "Human-readable error description"
}
```

| Status Code | Meaning |
|---|---|
| `400` | Bad Request — missing or invalid parameters |
| `401` | Unauthorized — missing/invalid token or API key |
| `403` | Forbidden — insufficient permissions or kiosk offline |
| `404` | Not Found — resource does not exist |
| `409` | Conflict — duplicate resource (e.g., email already in use) |
| `500` | Internal Server Error |

---

## 1. AUTH API — `/api/v1/auth`

These endpoints handle user authentication and registration. No authentication is required for `login` and `register`.

---

### POST `/api/v1/auth/login`

Authenticate a user and receive a JWT token.

**Headers Required:** None

**Request Body:**

```json
{
  "email": "admin@example.com",
  "password": "your_password"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `email` | `string` | Yes | User's email address |
| `password` | `string` | Yes | User's password |

**Success Response — `200 OK`:**

```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "full_name": "John Doe",
    "email": "admin@example.com",
    "role": "Super Admin",
    "partner_name": "Uni-Smiles HQ"
  }
}
```

**Error Responses:**

| Status | Condition |
|---|---|
| `400` | Missing `email` or `password` |
| `401` | Invalid email or password |

---

### POST `/api/v1/auth/register`

Register a new user account.

**Headers Required:** None

**Request Body:**

```json
{
  "full_name": "Jane Doe",
  "email": "jane@example.com",
  "password": "secure_password",
  "role": "operator",
  "partner_name": "Mitra Bandung"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `full_name` | `string` | Yes | User's full name |
| `email` | `string` | Yes | Unique email address |
| `password` | `string` | Yes | Account password |
| `role` | `string` | Yes | `"admin"` → stored as `"Super Admin"`, `"operator"` → stored as `"Admin Mitra"` |
| `partner_name` | `string` | No | Partner/organization name (relevant for `operator` role) |

**Success Response — `201 Created`:**

```json
{
  "success": true,
  "message": "User registered successfully"
}
```

**Error Responses:**

| Status | Condition |
|---|---|
| `400` | Missing required fields (`full_name`, `email`, `password`, `role`) |
| `409` | Email already in use |

---

### GET `/api/v1/auth/me`

Get the currently authenticated user's profile.

**Headers Required:**

```
Authorization: Bearer <token>
```

**Request Body:** None

**Success Response — `200 OK`:**

```json
{
  "success": true,
  "user": {
    "id": 1,
    "full_name": "John Doe",
    "email": "admin@example.com",
    "role": "Super Admin",
    "partner_name": "Uni-Smiles HQ"
  }
}
```

**Error Responses:**

| Status | Condition |
|---|---|
| `401` | Missing, invalid, or expired token |
| `404` | User not found in database |

---

## 2. PUBLIC API — `/api/v1/public`

Public endpoints accessible without any authentication.

---

### GET `/api/v1/public/settings`

Retrieve public system configuration. Used by kiosks and frontends to get global app settings.

**Headers Required:** None

**Request Body:** None

**Success Response — `200 OK`:**

```json
{
  "success": true,
  "data": {
    "app_name": "Uni-Smiles",
    "default_price": 10000,
    "maintenance_mode": false
  }
}
```

> **Note:** The `data` object contains dynamic key-value pairs based on system settings stored in the database. Keys and values vary depending on configuration. Values are automatically parsed to their correct types (`integer`, `decimal`, `boolean`, `json`, or `string`).

**Error Responses:**

| Status | Condition |
|---|---|
| `500` | Database or server error |

---

## 3. KIOSK API — `/api/v1/kiosk`

All kiosk endpoints require the `x-api-key` header. The middleware validates the key against the `kiosks` table and also checks that the kiosk status is not `offline`.

**Headers Required for ALL Kiosk endpoints:**

```
x-api-key: <kiosk_api_key>
```

---

### GET `/api/v1/kiosk/payments`

Get the payment methods available for the kiosk's owner (user).

**Request Body:** None

**Success Response — `200 OK`:**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "user_id": 1,
      "payment_type": "QRIS",
      "payment_data": "{\"qris_image_url\": \"/uploads/abc123\"}"
    }
  ]
}
```

**Error Responses:**

| Status | Condition |
|---|---|
| `401` | Missing or invalid API key |
| `403` | Kiosk is offline |
| `500` | Server error |

---

### POST `/api/v1/kiosk/sessions/start`

Start a new photo booth session. Generates a unique 8-character session code.

**Request Body:**

```json
{
  "frame_template_id": 5
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `frame_template_id` | `integer` | Yes | ID of the selected frame template |

**Success Response — `201 Created`:**

```json
{
  "success": true,
  "session_code": "A1B2C3D4"
}
```

**Error Responses:**

| Status | Condition |
|---|---|
| `401` | Missing or invalid API key |
| `403` | Kiosk is offline |
| `500` | Server error |

---

### POST `/api/v1/kiosk/sessions/:session_code/payment`

Verify and record payment for a session. Currently uses manual QRIS verification — the transaction is marked as `success` immediately (MVP behavior).

**URL Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `session_code` | `string` | The session code returned from `/sessions/start` |

**Request Body:** None (amount is derived from the kiosk's `base_price`)

**Success Response — `200 OK`:**

```json
{
  "success": true,
  "transaction_code": "TRX-1690000000000"
}
```

**Error Responses:**

| Status | Condition |
|---|---|
| `401` | Missing or invalid API key |
| `403` | Kiosk is offline |
| `500` | Server error |

---

### POST `/api/v1/kiosk/sessions/:session_code/photos`

Upload a photo taken during the session.

**Content-Type:** `multipart/form-data`

**URL Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `session_code` | `string` | The session code |

**Form Data Fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `photo` | `file` | Yes | The photo file to upload |
| `session_code` | `string` | Yes | Session code (also sent in the body) |

**Success Response — `201 Created`:**

```json
{
  "success": true,
  "url": "/uploads/a1b2c3d4e5f6"
}
```

**Error Responses:**

| Status | Condition |
|---|---|
| `400` | No photo file provided |
| `401` | Missing or invalid API key |
| `403` | Kiosk is offline |
| `500` | Server error |

---

### PUT `/api/v1/kiosk/sessions/:session_code/complete`

Mark a session as completed after all photos have been taken.

**URL Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `session_code` | `string` | The session code |

**Request Body:** None

**Success Response — `200 OK`:**

```json
{
  "success": true
}
```

**Error Responses:**

| Status | Condition |
|---|---|
| `401` | Missing or invalid API key |
| `403` | Kiosk is offline |
| `500` | Server error |

---

## 4. ADMIN API — `/api/v1/admin`

All admin endpoints require JWT authentication via the `Authorization` header. The middleware verifies the token and checks the user exists in the database.

**Headers Required for ALL Admin endpoints:**

```
Authorization: Bearer <token>
```

---

### GET `/api/v1/admin/dashboard`

Get aggregated dashboard statistics for the authenticated admin.

**Request Body:** None

**Success Response — `200 OK`:**

```json
{
  "success": true,
  "data": {
    "total_kiosks": 3,
    "total_sessions": 127,
    "total_revenue": 1270000
  }
}
```

| Field | Type | Description |
|---|---|---|
| `total_kiosks` | `number` | Count of active (non-deleted) kiosks owned by the user |
| `total_sessions` | `number` | Count of completed sessions across all user's kiosks |
| `total_revenue` | `number` | Sum of successful transaction amounts |

**Error Responses:**

| Status | Condition |
|---|---|
| `401` | Missing, invalid, or expired token |
| `500` | Server error |

---

### GET `/api/v1/admin/kiosks`

List all kiosks belonging to the authenticated admin.

**Request Body:** None

**Success Response — `200 OK`:**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Kiosk Bandung 1",
      "location": "Mall Bandung Lt. 2",
      "base_price": 10000,
      "api_key": "kiosk_a1b2c3d4e5f6...",
      "status": "active",
      "health": "healthy",
      "last_heartbeat": "2026-07-21T10:30:00.000Z"
    }
  ]
}
```

**Error Responses:**

| Status | Condition |
|---|---|
| `401` | Missing, invalid, or expired token |
| `500` | Server error |

---

### POST `/api/v1/admin/kiosks`

Create a new kiosk. An API key is automatically generated.

**Request Body:**

```json
{
  "name": "Kiosk Jakarta 1",
  "location": "Plaza Indonesia Lt. 3",
  "base_price": 15000
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | Yes | Display name for the kiosk |
| `location` | `string` | Yes | Physical location description |
| `base_price` | `number` | Yes | Price per session in IDR |

**Success Response — `201 Created`:**

```json
{
  "success": true,
  "message": "Kiosk created successfully",
  "data": {
    "api_key": "kiosk_a1b2c3d4e5f6789012345678901234"
  }
}
```

> **Important:** The `api_key` is only returned once during creation. Store it securely — it is used by the kiosk client for all `/api/v1/kiosk/*` endpoints.

**Error Responses:**

| Status | Condition |
|---|---|
| `401` | Missing, invalid, or expired token |
| `500` | Server error |

---

### GET `/api/v1/admin/payment-profile`

Get the admin's default payment profile (QRIS configuration).

**Request Body:** None

**Success Response — `200 OK`:**

```json
{
  "success": true,
  "data": {
    "id": 1,
    "user_id": 1,
    "payment_type": "QRIS",
    "payment_data": "{\"qris_image_url\": \"/uploads/abc123\"}"
  }
}
```

> **Note:** Returns `null` for `data` if no payment profile has been configured yet.

**Error Responses:**

| Status | Condition |
|---|---|
| `401` | Missing, invalid, or expired token |
| `500` | Server error |

---

### POST `/api/v1/admin/payment-profile/qris`

Upload or update the admin's QRIS image for payment. Uses upsert logic — creates a new profile if none exists, updates if one already exists.

**Content-Type:** `multipart/form-data`

**Form Data Fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `qris_image` | `file` | Yes | QRIS image file (PNG/JPG) |

**Success Response — `200 OK`:**

```json
{
  "success": true,
  "url": "/uploads/a1b2c3d4e5f6"
}
```

**Error Responses:**

| Status | Condition |
|---|---|
| `400` | No file uploaded |
| `401` | Missing, invalid, or expired token |
| `500` | Server error |

---

### GET `/api/v1/admin/templates`

List all frame templates belonging to the authenticated admin.

**Request Body:** None

**Success Response — `200 OK`:**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "Classic 2x2",
      "image_url": "/uploads/frame_abc123",
      "slot_count": 4,
      "layout_config": "{\"rows\":2,\"cols\":2,\"slots\":[...]}",
      "status": "active"
    }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `id` | `number` | Template ID |
| `name` | `string` | Template display name |
| `image_url` | `string` | Path to the frame image |
| `slot_count` | `number` | Number of photo slots in the frame |
| `layout_config` | `string` (JSON) | JSON string defining slot positions and dimensions |
| `status` | `string` | Template status (`"active"`) |

**Error Responses:**

| Status | Condition |
|---|---|
| `401` | Missing, invalid, or expired token |
| `500` | Server error |

---

### POST `/api/v1/admin/templates`

Upload a new frame template with its layout configuration.

**Content-Type:** `multipart/form-data`

**Form Data Fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `frame_image` | `file` | Yes | The frame template image file |
| `name` | `string` | Yes | Template display name |
| `slot_count` | `number` | Yes | Number of photo slots |
| `layout_config` | `string` (JSON) | Yes | Stringified JSON defining slot layout |

**Example `layout_config` value:**

```json
{
  "rows": 2,
  "cols": 2,
  "slots": [
    { "x": 10, "y": 10, "width": 200, "height": 150 },
    { "x": 220, "y": 10, "width": 200, "height": 150 },
    { "x": 10, "y": 170, "width": 200, "height": 150 },
    { "x": 220, "y": 170, "width": 200, "height": 150 }
  ]
}
```

> **Note:** When sent via `FormData`, `layout_config` arrives as a string. The backend safely handles both string and object forms before database insertion.

**Success Response — `201 Created`:**

```json
{
  "success": true,
  "message": "Template uploaded successfully"
}
```

**Error Responses:**

| Status | Condition |
|---|---|
| `400` | No file uploaded |
| `401` | Missing, invalid, or expired token |
| `500` | Server error |

---

## Endpoint Summary

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/api/v1/auth/login` | None | Login and get JWT |
| `POST` | `/api/v1/auth/register` | None | Register new user |
| `GET` | `/api/v1/auth/me` | Bearer Token | Get current user profile |
| `GET` | `/api/v1/public/settings` | None | Get public system config |
| `GET` | `/api/v1/kiosk/payments` | API Key | Get payment methods |
| `POST` | `/api/v1/kiosk/sessions/start` | API Key | Start photo session |
| `POST` | `/api/v1/kiosk/sessions/:session_code/payment` | API Key | Record payment |
| `POST` | `/api/v1/kiosk/sessions/:session_code/photos` | API Key | Upload photo |
| `PUT` | `/api/v1/kiosk/sessions/:session_code/complete` | API Key | Complete session |
| `GET` | `/api/v1/admin/dashboard` | Bearer Token | Get dashboard stats |
| `GET` | `/api/v1/admin/kiosks` | Bearer Token | List kiosks |
| `POST` | `/api/v1/admin/kiosks` | Bearer Token | Create kiosk |
| `GET` | `/api/v1/admin/payment-profile` | Bearer Token | Get payment profile |
| `POST` | `/api/v1/admin/payment-profile/qris` | Bearer Token | Upload QRIS image |
| `GET` | `/api/v1/admin/templates` | Bearer Token | List frame templates |
| `POST` | `/api/v1/admin/templates` | Bearer Token | Upload frame template |
