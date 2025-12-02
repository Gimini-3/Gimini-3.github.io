---
title: "[Java Multithreading] 마지막 글 - 스레드 관점에서 한눈에 정리: new → start → run → 종료 후 상태"
date: 2025-10-06 14:41:00 +0900
tags: 
  - java
  - concurrency
  - thread
  - start
  - run
  - jvm
thumbnail: "/assets/img/thumbnail/thread-start.png"
---
# [Java Multithreading] 마지막 글 - 스레드 관점에서 한눈에 정리: new → start → run → 종료 후 상태

앞선 글에서:

- **Part 1**: `run()` vs `start()` – 왜 결과가 다른지 (OS 스레드 생성 유무)
- **Part 2**: `start()` 뒤에서 벌어지는 일 – `start0()` → `JVM_StartThread` → `JavaThread`
- **Part 3**: OS 스레드 생성 과정 – `os::create_thread` → `pthread_create` → `glibc` → `clone()`
- **Part 4**: 새 스레드가 자바 `run()`까지 올라오기 – `thread_native_entry` → `JavaThread::run` → `thread_entry` → `Thread.run()`

까지 상세히 따라갔다.

이 마지막 글에서는 큰 그림을 한 번에 정리한다.

- 자바에서 `new Thread(...).start()`를 호출하는 순간부터
- OS 커널이 스레드를 만들고
- JVM이 초기화하고
- 자바 `run()`이 실행되고
- 스레드가 종료되어 `TERMINATED` 상태로 남을 때까지

를 **단일 다이어그램 + 단계별 요약**으로 정리해보자.

---

## 1. 한 장으로 보는 전체 다이어그램

먼저, 전체 흐름을 위에서 아래로 쭉 그려보면 이렇게 된다.

```text
[Java 코드 영역]
  A1  new Thread(runnable)
      └─ 자바 힙에 Thread 객체만 생성 (OS 스레드는 아직 없음)
          ↓
  A2  thread.start() 호출
          ↓
  A3  Thread.start() 자바 메서드
      └─ synchronized(this)로 this(Thread 객체) 모니터 락 획득
      └─ 상태 검사: 이미 시작된 스레드면 IllegalThreadStateException
          ↓
  A4  native 메서드 start0() 호출
      └─ 자바 → 네이티브 코드(JNI)로 진입

───────────────────────────────────────────────────────────────

[JVM 네이티브 (HotSpot C++) 영역]
  B1  JVM_StartThread(env, jthread)
      └─ JNI로 연결된 C++ 함수
      └─ jthread = 자바의 java.lang.Thread 인스턴스
          ↓
  B2  새 JavaThread 생성
      └─ new JavaThread(thread_entry, stackSize)
      └─ HotSpot 내부에서 자바 스레드를 표현하는 C++ 객체
      └─ entry_point = thread_entry 로 설정
          ↓
  B3  JavaThread.prepare(jthread)
      └─ JavaThread ↔ java.lang.Thread 연결
         - JavaThread 내부에 자바 Thread 객체 핸들 저장
         - 자바 Thread 쪽에도 native thread 포인터 연결
          ↓
  B4  os::create_thread(JavaThread*, threadType, stackSize) 호출
      └─ 플랫폼 의존 OS 스레드 생성 함수로 위임
      └─ threadType = java_thread / compiler_thread 등
          ↓
  B5  Threads_lock 잡고 JVM 스레드 목록에 등록 준비
      └─ JVM 전역 스레드 리스트에 추가하기 위한 동기화

───────────────────────────────────────────────────────────────

[OS / glibc / 커널 영역]
  C1  os::create_thread 내부에서 pthread_create 호출 (Linux 기준)
      └─ OSThread 객체 생성 후 JavaThread에 연결
      └─ pthread_attr 설정 (detach, stack size, guard page 등)
          ↓
  C2  glibc pthread_create → clone() 시스템 콜
      └─ 유저 공간(glibc)에서 커널 clone() 호출
          ↓
  C3  Linux 커널이 task_struct 생성
      └─ 새 스레드용 task_struct 생성
      └─ 스케줄러에 새 스레드 등록 (Runnable 상태에 올림)
          ↓
  C4  새 OS 스레드의 시작 루틴 실행
      └─ thread_native_entry(Thread*) 함수부터 실행 시작
      └─ 인자로 JavaThread* 포인터를 전달받음

───────────────────────────────────────────────────────────────

[새 OS 스레드 초기화 (thread_native_entry)]
  D1  스택 베이스/크기 기록
      └─ stack base / stack size를 기록해서
         - 스택 오버플로 감지
         - 스택 워킹, 샘플링, GC 등에 사용
          ↓
  D2  TLS, 시그널 마스크, FPU 상태 등 초기화
      └─ Thread::initialize_thread_current()
      └─ current thread 바인딩, NUMA, 시그널 마스크, FPU 상태 설정
          ↓
  D3  OSThread 상태를 INITIALIZED 로 설정
      └─ "OS 스레드 생성 완료, 아직 본격 실행 전" 상태
          ↓
  D4  startThread_lock 모니터에서 부모와 핸드셰이크
      └─ 부모에게 INITIALIZED 상태를 알리고 notify_all
      └─ 그 다음, osthread->state == INITIALIZED 인 동안 wait
      └─ 즉, 부모가 "이제 달려도 된다" 신호 줄 때까지 대기
          ↓
  D5  부모가 상태를 RUNNABLE 로 바꾸고 notify → wait 탈출
      └─ 부모 스레드: os::start_thread → pd_start_thread
      └─ RUNNABLE로 변경 + startThread_lock.notify()
      └─ 자식 스레드: wait_without_safepoint_check()에서 깨어남
          ↓
  D6  thread->call_run() 호출
      └─ 가상 디스패치로 JavaThread::run() 실행

───────────────────────────────────────────────────────────────

[JavaThread 런타임 (run → thread_main_inner → entry_point)]
  E1  JavaThread::run()
      └─ 새 자바 스레드의 VM 내부 런루틴 시작점
          ↓
  E2  TLAB 초기화 / 스택 가드 / JFR·JVMTI 훅 등록
      └─ TLAB(Thread-Local Allocation Buffer) 준비
      └─ 스택 가드 페이지 설치 (스택 오버플로 감지)
      └─ JFR, JVMTI, DTrace에 thread-start 이벤트 알림
          ↓
  E3  thread_main_inner() 호출
      └─ 실제 자바 엔트리 포인트 실행을 담당하는 내부 함수
      └─ _threadObj(자바 Thread 객체 핸들) 확인
      └─ pending exception 없으면 entry_point 호출
          ↓
  E4  entry_point(this, this) 호출
      └─ 일반 JavaThread 의 경우 entry_point = thread_entry
      └─ 결국 thread_entry(JavaThread*, TRAPS)로 진입

───────────────────────────────────────────────────────────────

[자바 Thread.run() 호출 (thread_entry)]
  F1  thread_entry(JavaThread*, THREAD)
      └─ 자바 스레드 실행의 진짜 "시작점" 역할
      └─ TRAPS = 예외 컨텍스트 (JavaThread* THREAD로 확장)
          ↓
  F2  thread->threadObj() 로 java.lang.Thread 핸들 획득
      └─ 이 JavaThread와 매핑된 자바 Thread 객체(oop)를 Handle로 감싸 GC-safe하게 참조
          ↓
  F3  JavaCalls.call_virtual(..., "run", "()V") 호출
      └─ 수신자: Thread 인스턴스
      └─ 메서드: run, 시그니처: ()V
      └─ 가상 호출이기 때문에
         - Thread 서브클래스가 run() 오버라이드했다면 그 구현 실행
         - 아니면 기본 Thread.run() 실행
      └─ VM 상태를 _thread_in_Java로 전환하고 자바 코드로 점프
          ↓
  F4  자바 Thread.run() 안에서 Runnable.run() 실행
      └─ 기본 구현:
           public void run() {
             if (target != null) {
               target.run();
             }
           }
      └─ 익명 Runnable, 람다 등이 여기서 실제로 실행됨

───────────────────────────────────────────────────────────────

[스레드 종료 이후 처리]
  G1  run() 정상 종료 또는 예외 발생
      └─ 정상 종료: 스택을 타고 빠져나오며 thread_entry → JavaThread::thread_main_inner → JavaThread::run() 종료
      └─ 예외: pending exception으로 잡혀서
         - ThreadGroup의 uncaughtException 등으로 전달될 수 있음
          ↓
  G2  OS 스레드 종료
      └─ thread_native_entry 마지막에서 return
      └─ 커널 task_struct 정리, 스케줄러에서 제거
          ↓
  G3  JVM: JavaThread / OSThread 정리
      └─ Threads 리스트에서 제거
      └─ JVM 내부 구조체(JavaThread, OSThread) 리소스 해제
          ↓
  G4  자바 Thread 객체는 힙에 남아 있음
      └─ GC 대상이 되기 전까지 살아 있고
      └─ thread.getState() → TERMINATED 로 보임
      └─ 즉, "껍데기(자바 객체)는 남고, OS 스레드는 사라진 상태"

```

이제 이 큰 그림을 스레드 “상태”와 함께 단계별로 다시 정리해보자.

---

## 2. 스레드 라이프사이클 – 상태(state) 기준으로 다시 보기

### 2-1. NEW – 단순히 객체만 있는 상태

자바 코드:

```java
Thread t = new Thread(runnable);
```

이 시점에는:

- 힙에 `Thread` 객체 하나만 있을 뿐,
- OS 스레드도 없고,
- JVM 내부의 `JavaThread`/`OSThread`도 없다.
- `Thread.getState()`는 `NEW`.

즉, **그냥 “미래에 스레드가 될 수도 있는 자바 객체”만 있는 상태**다.

---

### 2-2. start() 호출 직후 – 자바 메서드 → 네이티브 진입

```java
t.start();
```

내부적으로:

1. `Thread.start()` 자바 메서드가 호출되고
    - `synchronized(this)`로 중복 시작 방지
    - `holder.threadStatus`를 보고 이미 시작된 스레드면 `IllegalThreadStateException` 던짐
2. 상태 체크를 통과하면 `start0()` 호출

```java
public void start() {
    synchronized (this) {
        if (holder.threadStatus != 0)
            throw new IllegalThreadStateException();
        start0();  // native
    }
}

```

여기서부터는 **자바 코드가 아닌 JVM 네이티브 코드**로 내려간다.

---

### 2-3. start0() → JVM_StartThread – JavaThread/OSThread 생성

`start0()`는 `native` 메서드이기 때문에, 앞에서 본 `registerNatives()`에 의해 `JVM_StartThread`와 매핑된다.

```c
JVM_ENTRY(void, JVM_StartThread(JNIEnv* env, jobject jthread))
  JavaThread* native_thread = nullptr;
  bool throw_illegal_thread_state = false;

  {
    MutexLocker ml(Threads_lock);

    if (java_lang_Thread::thread(JNIHandles::resolve_non_null(jthread)) != nullptr) {
      throw_illegal_thread_state = true;
    } else {
      jlong size = java_lang_Thread::stackSize(JNIHandles::resolve_non_null(jthread));
      size_t sz = size > 0 ? (size_t)size : 0;

      native_thread = new JavaThread(&thread_entry, sz);

      if (native_thread->osthread() != nullptr) {
        native_thread->prepare(jthread); // 자바 Thread 객체와 연결
      }
    }
  }

  if (throw_illegal_thread_state) {
    THROW(vmSymbols::java_lang_IllegalThreadStateException());
  }
  if (native_thread->osthread() == nullptr) {
    THROW_MSG(vmSymbols::java_lang_OutOfMemoryError(), "Failed to create native thread");
  }

  Thread::start(native_thread);
JVM_END

```

여기서:

- **`JavaThread`**: JVM이 관리하는 C++ 스레드 객체
- **`OSThread`**: OS 스레드 핸들을 캡슐화한 객체
- `prepare(jthread)`로 `JavaThread` ↔ 자바 `Thread` 객체를 연결해 둔다.
- 마지막에 `Thread::start(native_thread)`에서 **실제 실행을 허용하는 플래그**를 바꾸게 된다.

---

### 2-4. OS 레벨 – os::create_thread → pthread_create → clone()

`JavaThread` 생성자 내부에서는 `os::create_thread`로 넘어간다.

```cpp
JavaThread::JavaThread(ThreadFunction entry_point, size_t stack_sz, MemTag mem_tag)
  : JavaThread(mem_tag) {
  set_entry_point(entry_point);

  os::ThreadType thr_type = os::java_thread;
  thr_type = entry_point == &CompilerThread::thread_entry
             ? os::compiler_thread
             : os::java_thread;

  os::create_thread(this, thr_type, stack_sz);
}

```

`os::create_thread` (Linux 기준):

- `OSThread` 할당, 상태 `ALLOCATED`
- `pthread_attr` 설정 (detach, stack size, guard size)
- `pthread_create(&tid, &attr, thread_native_entry, thread)` 호출
- 자식이 `INITIALIZED`로 바꿀 때까지 `startThread_lock` 모니터에서 대기

`pthread_create` → glibc 내부:

- 내부에서 `clone()` 시스템콜 호출
- 커널이 새 `task_struct`를 만들고 실행 큐에 넣음
- 새 OS 스레드가 `thread_native_entry`를 실행하기 시작

이 시점에서:

- **OS 기준**: 새로운 실행 흐름(스레드)이 실제로 생성됨.
- **JVM 기준**: 이 OS 스레드는 HotSpot 관리 코드(`thread_native_entry`) 안으로 들어온 상태.

---

### 2-5. 새 스레드 초기화 + start barrier – INITIALIZED → RUNNABLE

자식 스레드는 `thread_native_entry(thread)`로 들어와서:

1. 스택/시그널/TLS/FPU 등 환경 초기화
2. `startThread_lock` 모니터에서 상태를 `INITIALIZED`로 바꾸고 부모에게 notify
3. 부모가 상태를 `RUNNABLE`로 바꾸고 notify를 줄 때까지 `wait()`

부모는:

- `JVM_StartThread` 마지막에 `Thread::start(native_thread)` 호출
- `Thread::start` 안에서:
    - 자바 `Thread` 객체 상태를 `RUNNABLE`로
    - `os::start_thread(native_thread)` 호출
- `os::start_thread`:
    - `OSThread` 상태를 `RUNNABLE`로
    - `pd_start_thread`에서 `startThread_lock->notify()` 호출

결국:

- 자식은 `while (state == INITIALIZED)` 루프를 빠져나오고
- 마침내 `thread->call_run()`으로 넘어간다.

---

### 2-6. JVM 내부 run 루틴 – JavaThread::run → thread_main_inner → entry_point

`thread->call_run()`은 `JavaThread::run()`을 호출한다.

`JavaThread::run()`:

- TLAB, stack guard, JFR/JVMTI, JNI 핸들 블록 등 **자바 스레드를 위한 VM 환경**을 세팅
- 마지막에 `thread_main_inner()` 호출

`thread_main_inner()`:

- `_threadObj`(자바 `Thread` 인스턴스) 확인
- pending exception이 없으면 `entry_point(this, this)` 호출
- 일반 자바 스레드의 경우 `entry_point == thread_entry`

> 즉, 여기서 드디어 thread_entry(JavaThread*, TRAPS)가 호출된다.

---

### 2-7. thread_entry – Thread.run()을 실제로 호출하는 지점

```cpp
static void thread_entry(JavaThread* thread, TRAPS) {
  HandleMark hm(THREAD);
  Handle obj(THREAD, thread->threadObj());
  JavaValue result(T_VOID);

  JavaCalls::call_virtual(&result,
                          obj,
                          vmClasses::Thread_klass(),
                          vmSymbols::run_method_name(),
                          vmSymbols::void_method_signature(),
                          THREAD);
}

```

이 코드가 하는 일:

1. `thread->threadObj()`로 자바 `Thread` 객체 핸들 확보
2. `JavaCalls::call_virtual(..., "run", "()V")` 호출
    - 가상 메서드 해석 (오버라이드된 `run()`이면 그걸 호출)
    - 스레드 상태 `_thread_in_vm` → `_thread_in_Java` 전환
    - 인터프리터 or JIT 코드로 진입
    - 예외 발생 시 `THREAD`에 pending exception으로 기록

최종적으로 실행되는 건 자바 코드:

```java
class MyThread extends Thread {
    @Override
    public void run() {
        System.out.println("MyThread run");
    }
}

Thread t = new MyThread();
t.start();
```

---

### 2-8. run() 종료 이후 – OS 스레드는 사라지지만, Thread 객체는 남는다

`run()`이 끝나면:

- OS 스레드는 커널에서 종료 처리되고, `task_struct`는 정리된다.
- JVM은 `JavaThread`/`OSThread`를 Threads 리스트에서 제거하고 내부 리소스를 정리한다.
- 하지만 **자바의 `Thread` 객체는 힙에 남아 있다.**
    - 이 객체는 GC 대상이 될 때까지 계속 존재할 수 있고
    - `thread.getState()`를 호출하면 `TERMINATED`를 반환한다.
    - 따라서 `join()` 같은 메서드에서 “이 스레드가 끝났는지” 여부를 확인할 수 있다.

> 그래서, 실행 단위(실제 OS 스레드)는 사라져도, 자바의 Thread 인스턴스라는 “껍데기”는 남아서 상태를 알려주는 역할을 한다.
>

---

## 3. `run()` vs `start()` – 이제 완전히 명확하게

이제 전체 그림을 봤으니 한 줄로 정리할 수 있다.

- `run()`을 직접 호출하면:
    - JVM은 OS 스레드, JavaThread, OSThread 아무 것도 만들지 않는다.
    - 그냥 **현재 스레드에서 메서드 하나를 호출하는 것**이다.
- `start()`를 호출하면:
    - `start0()` → `JVM_StartThread` → `JavaThread`/`OSThread` 생성
    - `os::create_thread` → `pthread_create` → `clone()`으로 OS 스레드 생성
    - 새 OS 스레드에서 `thread_native_entry` → `JavaThread::run` → `thread_entry` → `Thread.run()`이 호출된다.

> 따라서, start()는 “새로운 실행 흐름(새 OS 스레드) + 그 안에서 run() 실행”을 의미하고,
> 
> `run()` 직접 호출은 “지금 스레드에서 메서드 한 번 호출”을 의미한다.
>

이 차이를 이해하는 순간, **자바 스레드를 진짜 OS 스레드 관점에서 볼 수 있게 된다.**