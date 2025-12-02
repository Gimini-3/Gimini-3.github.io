---
title: "[Java Multithreading] Part 2 – Thread.start() 뒤에서 일어나는 일: registerNatives ~ JVM_StartThread ~ JavaThread"
date: 2025-10-03 17:30:00 +0900
tags: 
  - java
  - concurrency
  - thread
  - start
  - run
  - jvm
thumbnail: "/assets/img/thumbnail/thread-start.png"
---
# [Java Multithreading] Part 2 – Thread.start() 뒤에서 일어나는 일: registerNatives ~ JVM_StartThread ~ JavaThread

## 0. 이 글에서 다룰 범위

Part 1에서 정리한 핵심은 딱 이거였다.

- `run()` 직접 호출 → **새 스레드 안 만들고** 현재 스레드에서 그냥 메서드 호출
- `start()` 호출 → JVM이 **OS 스레드를 새로 만들고**, 그 스레드에서 `run()` 실행

그런데 “JVM이 OS 스레드를 새로 만든다” 라고만 하면 너무 추상적이다.

Part 2에서는 **자바 → 네이티브로 넘어가는 첫 구간**을 따라간다:

> Thread 클래스 로딩
>
>
> → `registerNatives()`
>
> → `native void start0()`
>
> → `JVM_StartThread`
>
> → `JavaThread` 생성까지
>

실제 OS 스레드(`pthread_create`, `clone()` 등)는 Part 3,

새 스레드가 `run()`까지 도달하는 길(`thread_entry`, `JavaThread::run`)은 Part 4에서 본다.

---

## 1. Thread 클래스 로딩 시점: `registerNatives()` 호출

먼저, `java.lang.Thread`의 일부이다.

```java
public class Thread implements Runnable {
    /* Make sure registerNatives is the first thing <clinit> does. */
    private static native void registerNatives();
    static {
        registerNatives();
    }

    ...
}

```

여기서 중요한 포인트는 세 가지다.

### 1-1. 정적 초기화 블록과 `<clinit>`

- `static { ... }` 는 **정적 초기화 블록**이다.
- 자바 클래스는 JVM에서
    - 로드(load)
    - 링크(link)
    - 초기화(initialize)

      단계를 거친다.

- 이 중 **초기화 단계**에서
    - static 필드 초기값 설정
    - `static { ... }` 블록 실행

      을 한다.

- 이 초기화 동작은 **클래스당 딱 한 번**만 일어난다.

즉, `Thread` 클래스가 처음 사용되는 시점에

`registerNatives()` 도 단 한 번 호출된다.

### 1-2. 왜 Thread에서 `registerNatives()`를 쓰나?

`Thread` 클래스 안에는 이런 메서드들이 있다.

```java
private native void start0();
private static native void sleep(long millis) throws InterruptedException;
private static native void yield();
...

```

- 이런 메서드는 **자바 코드 구현이 없고**, OS 의존적인 내부 동작(스레드 생성, sleep, yield 등)을 수행해야 한다.
- 따라서 실제 구현은 C/C++ 로 작성되어 있고, JVM이 **JNI(Java Native Interface)** 를 통해 호출한다.

문제는:

- 자바 입장에서는 그냥 `start0()` 이라는 이름만 알고,
- JVM 내부 C/C++ 함수 이름은 `JVM_StartThread` 같은 형태로 따로 있다.

그래서 JVM이 둘을 연결해 줘야 한다.

그 작업을 하는 게 바로 **`registerNatives()`** 다.

### 1-3. “<clinit>에서 제일 먼저 해야 하는 일”

주석을 다시 보자.

```java
/* Make sure registerNatives is the first thing <clinit> does. */

```

- `<clinit>`은 컴파일러가 만드는 “클래스 초기화 메서드” 이름이다.
- 이 안에서 제일 먼저 `registerNatives()`를 호출하라는 의미다.

왜냐면:

- `registerNatives()`가 **네이티브 메서드 → C 함수 포인터 매핑**을 등록하기 전에
- 자바 코드에서 `start0()`, `sleep()` 같은 네이티브를 호출해 버리면
- 아직 연결이 안 돼 있어서 `UnsatisfiedLinkError` 가 날 수 있다.

그래서:

> Thread 클래스가 로딩/초기화될 때
>
>
> 제일 먼저 네이티브 매핑을 등록해 둔다.
>

---

## 2. C 쪽 구현: `Java_java_lang_Thread_registerNatives`

이제 OpenJDK 네이티브 코드를 보자.

[https://github.com/openjdk/jdk](https://github.com/openjdk/jdk)

```c
// openjdk/src/java.base/share/native/libjava/Thread.c

static JNINativeMethod methods[] = {
    {"start0", "()V", (void *)&JVM_StartThread},
    // ... sleep, yield 등 다른 메서드들
};

JNIEXPORT void JNICALL
Java_java_lang_Thread_registerNatives(JNIEnv *env, jclass cls) {
    (*env)->RegisterNatives(env, cls, methods,
            sizeof(methods)/sizeof(methods[0]));
}

```

여기서 나오는 개념들을 하나씩 정리해 보자.

### 2-1. `JNINativeMethod` 구조체

```c
typedef struct {
    const char* name;       // 자바 메서드 이름
    const char* signature;  // 시그니처 문자열 (예: "()V", "(J)V")
    void*       fnPtr;      // 네이티브 함수 포인터
} JNINativeMethod;

```

- `name` : 자바 쪽 메서드 이름 (`"start0"`)
- `signature` : 메서드 시그니처
    - `()V` → 인자 없음, 반환 void
    - `(J)V` → long 하나 받고, 반환 void 등
- `fnPtr` : 실제 호출할 C 함수 주소 (`&JVM_StartThread`)

즉, 이 한 줄로

```c
{"start0", "()V", (void *)&JVM_StartThread}

```

> “자바의 private native void start0() 는
>
>
> C 함수 `JVM_StartThread` 로 연결된다”
>

라는 매핑 정보를 JVM에 준 셈이다.

### 2-2. JNI 네이밍 규칙: `Java_패키지_클래스_메서드`

`Java_java_lang_Thread_registerNatives` 라는 이름은

**JNI 네이밍 규칙**에 따라 만들어진 함수다.

- `Java_` + `java_lang_Thread` + `_registerNatives`
- 자바의 `java.lang.Thread.registerNatives()` 메서드와 연결된다.

JVM은 `registerNatives()`를 호출할 때 이 네이티브 함수를 찾아 실행한다.

### 2-3. `RegisterNatives` 호출

```c
(*env)->RegisterNatives(env, cls, methods,
    sizeof(methods)/sizeof(methods[0]));

```

- `env` : JNI 환경 포인터. JNI 함수들을 호출하는 “핸들”이다.
- `cls` : `java.lang.Thread.class`에 해당하는 JNI 타입(jclass).
- `methods` 배열을 넘기면,
    - JVM은 **Thread 클래스 내부의 네이티브 메서드 테이블**에

      `"start0" → JVM_StartThread` 같은 매핑을 등록한다.


이제 자바 코드에서 `start0()`을 호출하면, JVM은 이 테이블을 보고

**어떤 C 함수를 호출해야 할지** 알게 된다.

---

## 3. `start()` → `start0()` → 매핑된 네이티브 함수 호출

자바 쪽 `start()`는 Part 1에서 봤듯이 이렇게 생겼다.

```java
public void start() {
    synchronized (this) {
        if (holder.threadStatus != 0)
            throw new IllegalThreadStateException();
        start0();
    }
}

```

핵심:

- 자바 코드에서 할 수 있는 일
    - 상태 체크 (`threadStatus == 0` 인지)
    - 동기화 (`synchronized (this)`)
- **실제 스레드 생성은 못 한다.**
    - OS API 호출은 자바 레벨에서 직접 못 하기 때문.

그래서 마지막에:

```java
private native void start0();
```

를 호출한다. 이 순간:

1. JVM은 `Thread` 클래스의 네이티브 테이블에서 `"start0"`을 찾는다.
2. `JVM_StartThread` 함수 포인터가 매핑되어 있음.
3. 자바 스택에서 네이티브(호출자: JVM) 스택으로 전환하면서 C 함수 `JVM_StartThread`로 점프한다.

---

## 4. `JVM_StartThread` – JVM 내부에서 진짜 “스레드”를 만드는 시작점

이제 OpenJDK의 `JVM_StartThread` 쪽 코드 흐름을 보자.

(실제 코드는 훨씬 길고 복잡하니, 핵심만 간추린 형태로 본다.)

```cpp
JVM_ENTRY(void, JVM_StartThread(JNIEnv* env, jobject jthread))
  JavaThread* native_thread = nullptr;
  bool throw_illegal_thread_state = false;

  {
    MutexLocker ml(Threads_lock);

    // 1. 이미 시작된 Thread인지 확인
    if (java_lang_Thread::thread(JNIHandles::resolve_non_null(jthread)) != nullptr) {
      throw_illegal_thread_state = true;
    } else {
      // 2. 자바 Thread의 stackSize 가져오기
      jlong size = java_lang_Thread::stackSize(JNIHandles::resolve_non_null(jthread));
      size_t sz = size > 0 ? (size_t)size : 0;

      // 3. C++ 레벨 JavaThread 객체 생성 (실행 단위의 뼈대)
      native_thread = new JavaThread(&thread_entry, sz);

      // 4. 자바 Thread 객체와 JavaThread 연결
      if (native_thread->osthread() != nullptr) {
        native_thread->prepare(jthread);
      }
    }
  }

  // 5. 예외 처리: 이미 시작된 Thread인 경우
  if (throw_illegal_thread_state) {
    THROW(vmSymbols::java_lang_IllegalThreadStateException());
  }

  // 6. OS 스레드 생성 실패한 경우
  if (native_thread->osthread() == nullptr) {
    THROW_MSG(vmSymbols::java_lang_OutOfMemoryError(), "Failed to create native thread");
  }

  // 7. 실제 실행 시작 (OS 스케줄러에 등록)
  Thread::start(native_thread);
JVM_END

```

### 4-1. 매개변수: `JNIEnv* env`, `jobject jthread`

- `jthread` : 자바 힙에 있는 `java.lang.Thread` 인스턴스를 가리키는 JNI 핸들이다.
    - 우리가 자바에서 `t.start()`를 호출했다면, 이 `t`가 여기로 들어온다.
- `JNIHandles::resolve_non_null(jthread)` 는 JNI 핸들을 실제 oop(자바 객체 포인터)로 변환해 준다.

### 4-2. 이미 시작된 Thread인지 검사

```cpp
if (java_lang_Thread::thread(JNIHandles::resolve_non_null(jthread)) != nullptr) {
    throw_illegal_thread_state = true;
}
```

- 자바의 `Thread` 객체와 매핑된 `JavaThread` 가 이미 있는지 확인한다.
- 이미 있다면 = 이미 한 번 `start()` 된 스레드.
- 이 경우, 자바 코드와 동일하게 `IllegalThreadStateException`을 던진다.

여기서 바로 예외를 던지지 않고,

`throw_illegal_thread_state` 플래그만 세우고 잠시 밖으로 나가는 이유는:

- 안쪽 블록 `{ MutexLocker ml(Threads_lock); ... }` 에서 `Threads_lock` 이라는 전역 락을 잡고 있기 때문.
- 락을 쥔 상태로 예외를 던지면, 락 해제 타이밍이 꼬일 수 있으니

  먼저 블록을 빠져나가 락을 해제한 후에 예외를 던진다.


### 4-3. `JavaThread` 생성

```cpp
native_thread = new JavaThread(&thread_entry, sz);
```

여기서 정말 중요한 타입이 하나 나온다.

- **`JavaThread`**
    - HotSpot JVM 내부에서 “자바 스레드”를 나타내는 C++ 클래스.
    - 자바 `Thread` 객체와 OS 스레드 사이를 이어주는 **JVM 레벨 추상화**다.
    - 생성자 인자:
        - `entry_point` : 새 스레드가 시작하면 실제로 호출할 C++ 함수 포인터
            - 여기서는 `thread_entry` 가 들어간다.
        - `sz` : 스택 크기 힌트

이 시점에서 하는 일은 대략:

1. JVM 내부에 `JavaThread` C++ 객체를 하나 만든다.
2. 내부에서 `os::create_thread(this, thr_type, stack_sz)` 를 호출해

   OS 스레드 생성(pthread 등)을 시도한다. (이건 Part 3에서 자세히 보기)

3. OS 스레드 생성에 성공하면, `JavaThread` 안에 `OSThread*` 필드를 채운다.

```cpp
// openjdk/jdk/src/hotspot/share/runtime/javaThread.cpp

JavaThread::JavaThread(ThreadFunction entry_point, size_t stack_sz, MemTag mem_tag) 
  : JavaThread(mem_tag) {
  set_entry_point(entry_point);

  // 어떤 타입의 스레드인지 결정
  os::ThreadType thr_type = os::java_thread;
  thr_type = entry_point == &CompilerThread::thread_entry 
             ? os::compiler_thread 
             : os::java_thread;

  // 실제 OS 스레드 생성
  os::create_thread(this, thr_type, stack_sz);

  // 이 시점에서 _osthread는 null일 수 있음 (리소스 부족 같은 경우)
  // 따라서 바로 예외를 던지지 않고, 상위 호출자(JVM_StartThread)가 나중에 처리
  //
  // 그리고 여기서 바로 실행 시작되지 않음
  // 반드시 creator가 명시적으로 os::start_thread()를 불러줘야 스레드가 달리기 시작
  // (Threads::add() 호출도 마찬가지로 JVM_StartThread 쪽에서 처리)
}

```

즉, `new JavaThread(...)` 는

> “JVM 내부 스레드 객체 생성 + OS 스레드 생성 요청”
>

을 함께 수행하는 동작이다.

### 4-4. 자바 Thread 객체와 JavaThread 연결: `prepare(jthread)`

```cpp
if (native_thread->osthread() != nullptr) {
    native_thread->prepare(jthread);
}
```

- `native_thread->osthread()` 가 `nullptr` 이 아니라는 것은
    - OS 스레드가 정상적으로 생성됐다는 뜻이다.
- `prepare(jthread)` 는
    - C++ `JavaThread` 객체와
    - 자바 `Thread` 객체(`jthread`)

      를 **양방향으로 연결해 주는 작업**이다.


대략적인 개념은 이렇다:

- `JavaThread` 안에 “내가 담당하는 자바 Thread 객체(oop)”를 저장.
- 자바 `Thread` 객체의 필드에도 “나와 연결된 JavaThread 주소”를 저장.
- 나중에 어느 쪽에서든 서로를 찾을 수 있도록 매핑을 만들어 둔다.

이 작업 덕분에:

- 자바 코드에서 `Thread.currentThread()` 를 호출하면

  → 현재 OS 스레드에 매핑된 `JavaThread`

  → 거기에서 연결된 자바 `Thread` 객체를 찾아 돌려줄 수 있다.


---

## 5. JavaThread vs OSThread vs 자바 Thread 객체

여기까지 나오면 스레드 관련해서 이름이 헷갈리기 딱 좋다. 구조를 한 번 정리하고 가자.

### 5-1. 3단 구조

개념적으로는 이렇게 생겼다:

```
[OS 커널 스레드]
    ↑
  OSThread     (OS 핸들, pthread_t, Windows HANDLE 등)
    ↑
  JavaThread   (JVM 내부 C++ 스레드 객체)
    ↑
java.lang.Thread (자바 힙 객체)

```

- **OS 커널 스레드**
    - 실제 CPU 위에서 돌아가는 실행 단위.
    - 리눅스라면 `task_struct`, `clone()` 으로 만들어지는 그 대상.
- **OSThread (HotSpot C++ 클래스)**
    - OS 스레드 핸들을 감싸는 **플랫폼 의존 레이어**.
    - 내부에 `pthread_t`, 스레드 ID, 네이티브 핸들 등을 들고 있는 구조체/클래스.
- **JavaThread (HotSpot C++ 클래스)**
    - JVM이 관리하는 **플랫폼 독립 레벨** 스레드 객체.
    - GC, safepoint, JIT, 디버거/JVMTI 등 JVM 내부 기능과 깊이 연결되어 있다.
    - 필드 중 하나로 `OSThread* _osthread` 를 가지고 있어 OS 스레드와 연결된다.
    - 또 하나의 핸들로, 자바의 `java.lang.Thread` 객체(oop)를 들고 있다.
- **자바의 `Thread` 객체**
    - 우리가 자바 코드에서 `new Thread(...)` 로 만드는 인스턴스.
    - 이름, priority, daemon 여부, `run()` 로직, `stackSize` 설정 등을 가진다.
    - 내부적으로 `JavaThread` / `OSThread` 와 연결되어 실제 실행 단위를 제어한다.

### 5-2. 왜 `JavaThread`와 `OSThread`를 나누었을까?

핵심 이유는 두 가지다.

1. **플랫폼 독립성**
    - OS 스레드 표현은 OS마다 다르다.
        - 리눅스: `pthread_t`
        - 윈도우: `HANDLE`, `DWORD id` 등
    - 만약 JVM의 스레드 로직이 이런 OS 타입에 직접 의존하면,
        - 리눅스/윈도우/맥마다 코드가 죄다 달라져야 한다.
    - 그래서
        - `JavaThread` : GC, JIT, safepoint 등 **JVM 공통 로직**
        - `OSThread` : OS 핸들, native id 등 **플랫폼 의존 로직**

          로 분리해서 관리한다.

2. **JVM 내부 기능과의 결합**
    - GC, safepoint, 디버거, JFR 같은 기능은 모두 **JVM 레벨**에서 스레드를 관리해야 한다.
    - 이때 필요한 상태(스레드 state, 스택 정보, TLS, Java 프레임 정보 등)는

      OS 스레드 수준에는 없다.

    - 그래서 JVM이 필요한 모든 메타데이터를 `JavaThread`에 담고,

      OS 스레드는 그냥 “실행 수단”으로만 본다.


---

## 6. `JVM_StartThread`의 예외 처리

이제 앞부분에서 스킵했던 예외 처리 코드를 다시 보자.

```cpp
if (throw_illegal_thread_state) {
  THROW(vmSymbols::java_lang_IllegalThreadStateException());
}

if (native_thread->osthread() == nullptr) {
  THROW_MSG(vmSymbols::java_lang_OutOfMemoryError(), "Failed to create native thread");
}

```

- **이미 시작된 Thread인 경우**
    - 자바 레벨에서 `start()`를 두 번 호출하면 예외가 나는 이유를

      JVM도 동일하게 맞춰준다.

    - 여기서는 네이티브 코드에서 예외 객체를 생성하고,

      자바 호출 스택으로 되돌려 보내는 역할을 한다.

- **OS 스레드 생성 실패**
    - 리소스 부족, OS 스레드 제한 초과 등으로 `os::create_thread` 가 실패하면
    - `osthread()` 가 `nullptr` 로 남는다.
    - 이 경우 `OutOfMemoryError("Failed to create native thread")`를 던진다.
    - 스레드를 너무 많이 만들어서 JVM이 `OutOfMemoryError: unable to create new native thread` 를 던진다는 것은 여기서 발생하게 되는 것이다.

---

## 7. C++ 쪽 `Thread::start(native_thread)` – OS에 실제 실행을 요청하는 단계

자바 쪽 `Thread.start()` 말고,

C++ 쪽에도 `Thread::start(Thread*)` 라는 함수가 있다. (이름이 같아서 헷갈리기 쉽다.)

```cpp
// openjdk/src/hotspot/share/runtime/thread.cpp

void Thread::start(Thread* thread) {
  if (thread->is_Java_thread()) {
    java_lang_Thread::set_thread_status(
        JavaThread::cast(thread)->threadObj(),
        JavaThreadStatus::RUNNABLE);
  }
  os::start_thread(thread);
}

```

여기서 하는 일:

1. **자바 Thread 상태를 RUNNABLE로 설정**
    - 자바 쪽에서 `getState()` 등을 호출할 때 보는 상태를 맞춰준다.
    - 아직 실제로 CPU에서 돌고 있는 건 아니지만,

      “실행 가능한 상태”로 만든다.

2. **`os::start_thread(thread)` 호출**
    - OS 의존 레이어로 내려간다.
    - 내부에서 `pd_start_thread(thread)` 를 호출한다.
    - 이 부분은 “부모/자식 스레드 핸드셰이크”, “start barrier”를 다루는 구간이고

      자세한 내용은 Part 3~4에서 본다.


### 7-1. `os::start_thread`와 OS별 구현 결합

소스 구조는 대략 이런 식이다.

```cpp
// 공통 코드: openjdk/jdk/src/hotspot/share/runtime/os.cpp
void os::start_thread(Thread* thread) {
  OSThread* osthread = thread->osthread();
  osthread->set_state(RUNNABLE);
  pd_start_thread(thread);   // platform dependent 구현 호출
}

```

```cpp
// 리눅스 구현: openjdk/jdk/src/hotspot/os/linux/os_linux.cpp
void os::pd_start_thread(Thread* thread) {
  ...
  sync_with_child->notify(); // 자식 스레드 깨우는 신호
}

```

- `os::start_thread` 는 **플랫폼 독립 레이어**
    - 공통 상태 전환, 디버깅 훅, 공통 invariant 체크 등을 담당.
- `pd_start_thread` 는 **플랫폼 의존 레이어**
    - 리눅스/윈도우/맥마다 구현이 다르다.
    - 빌드할 때, 현재 타겟 OS에 맞는 파일만 컴파일/링크해서 붙인다.

즉:

> 소스 레벨에서는 os::start_thread 를 호출하지만,
>
>
> 빌드 타임에 OS별 구현(`os_linux.cpp` 등)과 심볼이 묶이기 때문에
>
> 실행 시에는 적절한 플랫폼 구현으로 바로 점프한다.
>

---

## 8. Part 2 전체 흐름 요약

지금까지를 “Thread.start() 뒤에서 벌어지는 일” 관점에서 정리하면:

1. **JVM 부팅 초반**
    - `java.lang.Thread` 클래스 로딩
    - `<clinit>` 안에서 `registerNatives()` 호출
    - JNI의 `RegisterNatives`를 통해
        - `"start0"` → `JVM_StartThread`
        - `"sleep"` → `JVM_Sleep`
        - ...

          매핑 테이블 등록

2. **자바 코드에서 `t.start()` 호출**
    - 자바 `Thread.start()` 실행
    - `synchronized(this)` 로 중복 start 방지
    - 상태 체크 후 `start0()` 호출
3. **네이티브 `start0()` → `JVM_StartThread` 진입**
    - JNI 테이블을 통해 `JVM_StartThread` C++ 함수로 점프
4. **`JVM_StartThread` 내부**
    - `jthread`(자바 Thread 객체)로부터 정보 추출
    - 이미 시작된 스레드인지 확인 → `IllegalThreadStateException` 대비
    - `new JavaThread(thread_entry, stackSize)` 로 JVM 내부 스레드 객체 생성
        - 이 과정에서 OS 스레드 생성 시도 (`os::create_thread`) (Part 3)
    - `JavaThread.prepare(jthread)` 로 자바 Thread 객체와 네이티브 스레드를 연결
    - 실패 시 `OutOfMemoryError` 등 예외 처리
    - 성공 시 `Thread::start(native_thread)` 호출
5. **C++ `Thread::start`**
    - 자바 `Thread` 상태를 `RUNNABLE` 로 세팅
    - `os::start_thread(native_thread)` 호출 → OS 의존 레이어로 내려감
6. **다음 파트**
    - Part 3: `os::create_thread` → `pthread_create` → glibc → `clone()` 까지

      진짜 OS 스레드가 어떻게 만들어지는지

    - Part 4: 새 스레드가 시작 루틴(`thread_native_entry`, `JavaThread::run`, `thread_entry`)을 지나

      최종적으로 자바 `Thread.run()` 에 도달하는 흐름